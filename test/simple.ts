/**
 * Simple smoke test: rotate the bundled sample image (test/fixtures/lenna.jpg).
 *
 * It checks, in order:
 *
 *   1. the module loads and reports the libjpeg version it was built from,
 *   2. a 90 degree rotation of the sample produces a valid JPEG file,
 *   3. the JFIF (APP0) segment survives the rotation unchanged,
 *   4. cropping the sample works and keeps the iMCU rules of jpegtran,
 *   5. rotating 90 and then 270 degrees decodes back to the original pixels,
 *   6. the rotation and the crop are byte-identical to the system `jpegtran`.
 *
 * Checks 5 and 6 need `djpeg` and `jpegtran`; they are skipped when those tools are not installed,
 * so this test also runs on a plain machine. The images are written to test/out/ so they can be
 * looked at. Run it with:
 *
 *   node test/simple.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { COPY, TRANSFORM, createRotator } from "../src/index.ts";

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const INPUT = path("./fixtures/lenna.jpg");
const OUT_DIR = path("./out/");

let passed = 0;
let skipped = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

function skip(name: string, reason: string): void {
  skipped++;
  console.log(`  skip  ${name} (${reason})`);
}

/** True when a command is installed on this machine. */
function has(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).error === undefined;
}

/** Runs a tool and returns its stdout, throwing when it fails. */
function run(command: string, args: string[]): Buffer {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

/** Walks the JPEG marker segments up to the image data and returns them as `{ marker, data }` entries. */
function segments(buffer: Buffer): { marker: number; data: Buffer }[] {
  const found: { marker: number; data: Buffer }[] = [];
  let offset = 2; // skip SOI
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS or EOI: entropy data follows
    const length = buffer.readUInt16BE(offset + 2);
    found.push({ marker, data: buffer.subarray(offset + 4, offset + 2 + length) });
    offset += 2 + length;
  }
  return found;
}

/** Reads the frame dimensions out of the SOF segment. */
function dimensions(buffer: Buffer): { width: number; height: number } {
  const sof = segments(buffer).find(
    (s) => s.marker >= 0xc0 && s.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(s.marker),
  );
  if (sof === undefined) throw new Error("no SOF segment");
  return { height: sof.data.readUInt16BE(1), width: sof.data.readUInt16BE(3) };
}

/** Decodes a JPEG to PPM through the system djpeg, so both sides share one decoder. */
function decode(buffer: Buffer, label: string): Buffer {
  const input = path(`./out/${label}.jpg`);
  const output = path(`./out/${label}.ppm`);
  writeFileSync(input, buffer);
  run("djpeg", ["-outfile", output, input]);
  return readFileSync(output);
}

mkdirSync(OUT_DIR, { recursive: true });

const input = readFileSync(INPUT);

console.log(`sample: ${INPUT} (${input.length} bytes)\n`);

// 1. the module loads
const rotator = await createRotator();
console.log(`libjpeg in the module: ${rotator.version()}\n`);
check("module reports a libjpeg version", /^\d+/.test(rotator.version()));

// 2. a 90 degree rotation produces a valid JPEG
const { data: rotated90, perfect, width: rotatedWidth, height: rotatedHeight } = rotator.rotate(input, 90, { copy: COPY.all });
const out90 = path("./out/lenna-rot90.jpg");
writeFileSync(out90, rotated90);
console.log(`\nrotate 90 -> ${out90} (${rotated90.length} bytes, perfect=${perfect})\n`);
check("output starts with SOI (ff d8)", rotated90[0] === 0xff && rotated90[1] === 0xd8);
check("output ends with EOI (ff d9)", rotated90.at(-2) === 0xff && rotated90.at(-1) === 0xd9);
check("output is not a copy of the input", Buffer.compare(Buffer.from(rotated90), input) !== 0);
check("transform is MCU aligned (perfect)", perfect === true);

const originalSize = dimensions(input);
check(
  `a 90 degree rotation swaps width and height (${originalSize.width}x${originalSize.height})`,
  rotatedWidth === originalSize.height && rotatedHeight === originalSize.width,
  `got ${rotatedWidth}x${rotatedHeight}`,
);

// 3. the JFIF segment is carried over unchanged
const app0 = (buffer: Buffer): string => JSON.stringify(segments(buffer).filter((s) => s.marker === 0xe0));
check("APP0 (JFIF) segment preserved", app0(input) === app0(Buffer.from(rotated90)));

// 4. cropping the sample: IJG moves the corner to an iMCU boundary and grows the region
const crop = rotator.crop(input, { width: 200, height: 150, x: 100, y: 50 });
writeFileSync(path("./out/lenna-crop.jpg"), crop.data);
console.log(`\ncrop 200x150+100+50 -> ${crop.width}x${crop.height} (${crop.data.length} bytes)\n`);
check("crop output starts with SOI (ff d8)", crop.data[0] === 0xff && crop.data[1] === 0xd8);
check("crop covers what was asked for", crop.width >= 200 && crop.height >= 150);
check("crop grows by at most one iMCU", crop.width <= 216 && crop.height <= 166);

// 5. rotating back gives the original pixels
if (has("djpeg")) {
  const { data: rotated270 } = rotator.rotate(input, 270, { copy: COPY.all });
  const roundTrip = rotator.transform(rotated90, { transform: TRANSFORM.rotate270, copy: COPY.all });
  writeFileSync(path("./out/lenna-rot90-rot270.jpg"), roundTrip);
  const before = decode(input, "lenna-original");
  const after = decode(Buffer.from(roundTrip), "lenna-roundtrip");
  check("90 + 270 decodes back to the original pixels", Buffer.compare(before, after) === 0);
  check(
    "270 degree rotation differs from the 90 degree one",
    Buffer.compare(Buffer.from(rotated90), Buffer.from(rotated270)) !== 0,
  );
} else {
  skip("90 + 270 round trip", "djpeg not installed");
}

// 6. the output is byte-identical to the system jpegtran
if (has("jpegtran")) {
  const rotationReference = path("./out/lenna-jpegtran-rot90.jpg");
  run("jpegtran", ["-rotate", "90", "-copy", "all", "-outfile", rotationReference, INPUT]);
  check(
    "rotation is byte-identical to jpegtran -rotate 90 -copy all",
    Buffer.compare(Buffer.from(rotated90), readFileSync(rotationReference)) === 0,
  );

  const cropReference = path("./out/lenna-jpegtran-crop.jpg");
  run("jpegtran", ["-copy", "all", "-crop", "200x150+100+50", "-outfile", cropReference, INPUT]);
  check(
    "crop is byte-identical to jpegtran -crop 200x150+100+50",
    Buffer.compare(Buffer.from(crop.data), readFileSync(cropReference)) === 0,
  );
} else {
  skip("comparison with jpegtran", "jpegtran not installed");
}

console.log(`\npassed: ${passed}   skipped: ${skipped}`);
