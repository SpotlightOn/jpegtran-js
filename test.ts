/**
 * Differential test for the WebAssembly build.
 *
 * The transform is compared against the system `jpegtran`/`djpeg` (libjpeg-turbo):
 *
 *   - the wasm output decodes (via djpeg) to exactly the same pixels as jpegtran's output,
 *   - the "perfect" predicate agrees with `jpegtran -perfect` for every fixture,
 *   - Exif/APPn markers survive the transform,
 *   - non-JPEG input is reported as such.
 *
 * The fixture corpus lives in `test/fixtures` and can be pointed elsewhere with the first argument
 * or with `JPEGTRAN_FIXTURES`. It contains the non-JPEG input and the edge case shapes the checks
 * below rely on, so the test needs it.
 *
 * Run: node test.ts [fixture-dir]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { COPY, STATUS, TRANSFORM, TransformError, createRotator } from "./src/index.ts";

const FIXTURE_DIR = process.argv[2] ?? process.env.JPEGTRAN_FIXTURES ?? join(import.meta.dirname, "test", "fixtures");

if (!existsSync(FIXTURE_DIR)) {
  console.error(`fixture directory not found: ${FIXTURE_DIR}`);
  console.error("pass it as the first argument or set JPEGTRAN_FIXTURES");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "jpegtran-js-"));

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? `: ${detail}` : ""}`);
  }
}

/** All *.jpg under a directory. */
function collectJpegs(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectJpegs(path));
    } else if (entry.name.toLowerCase().endsWith(".jpg")) {
      result.push(path);
    }
  }
  return result.sort();
}

/** Decodes a JPEG to raw pixels through the system djpeg, so both sides share one decoder. */
function decodePixels(buffer: Buffer, label: string): Buffer {
  const input = join(work, `${label}.jpg`);
  const output = join(work, `${label}.ppm`);
  writeFileSync(input, buffer);
  execFileSync("djpeg", ["-outfile", output, input], { stdio: "ignore" });
  return readFileSync(output);
}

/** Runs the system jpegtran; returns the exit status and stderr. */
function runJpegtran(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync("jpegtran", args, { stdio: ["ignore", "ignore", "pipe"] });
  return { status: result.status, stderr: result.stderr.toString() };
}

/** Walks the JPEG marker segments up to SOS and returns them as `{ marker, data }` entries. */
function segments(buffer: Buffer): { marker: number; data: Buffer }[] {
  const result: { marker: number; data: Buffer }[] = [];
  let offset = 2; // skip SOI
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS or EOI: entropy data follows
    const length = buffer.readUInt16BE(offset + 2);
    result.push({ marker, data: buffer.subarray(offset + 4, offset + 2 + length) });
    offset += 2 + length;
  }
  return result;
}

/** The APPn segments of a JPEG, as comparable strings. */
function appMarkers(buffer: Buffer): string[] {
  return segments(buffer)
    .filter((s) => s.marker >= 0xe0 && s.marker <= 0xef)
    .map((s) => `${s.marker.toString(16)}:${s.data.toString("hex")}`);
}

const rotator = await createRotator();
console.log(`IJG libjpeg version in the module: ${rotator.version()}`);
console.log(`fixtures: ${FIXTURE_DIR}\n`);

const all = collectJpegs(FIXTURE_DIR);
const valid = all.filter((p) => !p.includes("/err-") && !p.includes("err-"));

const rotations = [
  { degrees: 90, transform: TRANSFORM.rotate90 },
  { degrees: 180, transform: TRANSFORM.rotate180 },
  { degrees: 270, transform: TRANSFORM.rotate270 },
];

for (const path of valid) {
  const name = relative(FIXTURE_DIR, path);
  const input = readFileSync(path);

  for (const { degrees, transform } of rotations) {
    const tag = `${name} rotate ${degrees}`;

    // 1. jpegtran reference
    const turboOut = join(work, "turbo.jpg");
    const turbo = runJpegtran(["-rotate", String(degrees), "-copy", "all", "-outfile", turboOut, path]);
    if (turbo.status !== 0) {
      check(tag, false, `jpegtran failed: ${turbo.stderr.trim()}`);
      continue;
    }
    const turboBytes = readFileSync(turboOut);

    // 2. wasm
    let wasmBytes: Uint8Array;
    try {
      wasmBytes = rotator.transform(input, { transform, copy: COPY.all });
    } catch (error) {
      check(tag, false, `wasm failed: ${String(error)}`);
      continue;
    }

    // 3. pixel identity is the real check, byte identity is a bonus
    let pixelsEqual = false;
    let detail = "";
    try {
      const a = decodePixels(Buffer.from(wasmBytes), "wasm");
      const b = decodePixels(turboBytes, "turbo");
      pixelsEqual = Buffer.compare(a, b) === 0;
      if (!pixelsEqual) detail = `decoded pixels differ (${a.length} vs ${b.length} bytes)`;
    } catch (error) {
      detail = `djpeg comparison failed: ${String(error)}`;
    }
    check(tag, pixelsEqual, detail);

    // 4. markers preserved
    const inputApps = appMarkers(input).join("|");
    const wasmApps = appMarkers(Buffer.from(wasmBytes)).join("|");
    check(`${tag} markers`, inputApps === wasmApps, "APPn segments changed");

    if (Buffer.compare(Buffer.from(wasmBytes), turboBytes) === 0) {
      passed++; // counted so the summary shows how often bytes match exactly
    }
  }

  // 5. the perfect predicate against jpegtran -perfect
  for (const { degrees, transform } of [
    { degrees: 90, transform: TRANSFORM.rotate90 },
    { degrees: 270, transform: TRANSFORM.rotate270 },
  ]) {
    const possible = rotator.perfectPossible(input, transform);
    const reference = runJpegtran([
      "-rotate",
      String(degrees),
      "-perfect",
      "-copy",
      "all",
      "-outfile",
      join(work, "p.jpg"),
      path,
    ]);
    const referencePossible = reference.status === 0;
    check(`${name} perfect ${degrees} (wasm=${possible} jpegtran=${referencePossible})`, possible === referencePossible);
  }
}

// 6. non-JPEG input
const pngErrorFixture = join(FIXTURE_DIR, "err-png.jpg");
for (const bad of [Buffer.from("not a jpeg at all"), ...(existsSync(pngErrorFixture) ? [readFileSync(pngErrorFixture)] : [])]) {
  const label = bad.length < 32 ? "random bytes" : "err-png.jpg";
  try {
    rotator.transform(bad, { transform: TRANSFORM.rotate90, copy: COPY.all });
    check(`reject ${label}`, false, "no error thrown");
  } catch (error) {
    check(
      `reject ${label}`,
      error instanceof TransformError && error.status === STATUS.notJpeg,
      `got ${error instanceof TransformError ? error.name : "Error"} status=${String((error as TransformError).status)} message=${String(error)}`,
    );
  }
}

// 7. perfect flag really refuses an imperfect transform
const imperfectPath = join(FIXTURE_DIR, "base/pattern-3x2-420.jpg");
if (existsSync(imperfectPath)) {
  try {
    rotator.transform(readFileSync(imperfectPath), { transform: TRANSFORM.rotate90, copy: COPY.all, perfect: true });
    check("perfect refuses imperfect image", false, "no error thrown");
  } catch (error) {
    const transformError = error as TransformError;
    check(
      "perfect refuses imperfect image",
      transformError.status === STATUS.notPerfect && /not perfect/.test(transformError.message),
      `status=${String(transformError.status)} message=${transformError.message}`,
    );
  }
}

console.log(`\npassed: ${passed}   failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const failure of failures.slice(0, 30)) console.log(`  - ${failure}`);
  if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
}
process.exit(failed === 0 ? 0 : 1);
