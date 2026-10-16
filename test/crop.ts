/**
 * Differential test for the lossless crop.
 *
 * Crop is compared against `jpegtran -crop` (libjpeg-turbo) on the bundled sample and on fixtures
 * with different chroma subsampling. The interesting part is that IJG does not crop exactly where it
 * is told: it moves the upper left corner to an iMCU boundary and grows the region, so an
 * off-by-one crop spec is the real fidelity check.
 *
 * Covered:
 *
 *   - crop on its own and crop combined with a transform,
 *   - iMCU aligned and deliberately unaligned crop regions,
 *   - negative offsets (measured from the right/bottom edge),
 *   - omitted offsets,
 *   - the 'f' (force) suffix, which keeps the exact dimensions,
 *   - crop extension (a region larger than the image, only allowed without a transform),
 *   - the reported output dimensions,
 *   - the -perfect predicate,
 *   - invalid crop specifications, rejected by jpegtran and by the module alike.
 *
 * The chroma subsampling variants come from `test/fixtures/base`; pass another directory as the
 * first argument (or set `JPEGTRAN_FIXTURES`) to compare against a bigger corpus. The system
 * `jpegtran` is required, because it is the reference the results are compared against. Run with
 *
 *   node test/crop.ts [fixture-dir]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { COPY, STATUS, TRANSFORM, TransformError, createRotator, type TransformResult } from "../src/index.ts";

const FIXTURES = process.argv[2] ?? process.env.JPEGTRAN_FIXTURES ?? join(import.meta.dirname, "fixtures");
const sample = fileURLToPath(new URL("./fixtures/lenna.jpg", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "jpegtran-crop-"));

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

/** True when a command is installed on this machine. */
function hasCommand(command: string): boolean {
  return spawnSync(command, ["-version"], { stdio: "ignore" }).error === undefined;
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

/** Runs the system jpegtran and returns the exit status. */
function jpegtran(args: string[]): number | null {
  return spawnSync("jpegtran", args, { stdio: ["ignore", "ignore", "pipe"] }).status;
}

/** True when the module rejects a crop spec with STATUS.badCrop. */
function rejectsAsBadCrop(input: Uint8Array, transform: number, spec: string): boolean {
  try {
    rotator.transformDetailed(input, { transform, copy: COPY.all, crop: spec });
    return false;
  } catch (error) {
    return error instanceof TransformError && error.status === STATUS.badCrop;
  }
}

/** Compares a module result with the bytes and dimensions jpegtran produced. */
function compare(name: string, result: TransformResult, expected: Buffer): void {
  check(name, Buffer.compare(Buffer.from(result.data), expected) === 0, "bytes differ from jpegtran");
  const referenceDimensions = dimensions(expected);
  check(
    `${name} dimensions`,
    result.width === referenceDimensions.width && result.height === referenceDimensions.height,
    `reported ${result.width}x${result.height}, jpegtran wrote ${referenceDimensions.width}x${referenceDimensions.height}`,
  );
}

const rotator = await createRotator();

if (!hasCommand("jpegtran")) {
  console.error("jpegtran is required as the reference implementation for this differential test");
  process.exit(1);
}

interface TransformCase {
  name: string;
  transform: number;
  args: string[];
}

interface CropCase {
  spec: string;
  note: string;
}

interface BadCase {
  spec: string;
  transform: number;
  args: string[];
  note: string;
}

/** Crop specs relative to a WxH image, covering the interesting corners of the syntax. */
function specsFor(width: number, height: number): CropCase[] {
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);
  return [
    { spec: `${halfWidth}x${halfHeight}+${Math.floor(width / 4)}+${Math.floor(height / 4)}`, note: "aligned" },
    {
      spec: `${halfWidth + 1}x${halfHeight + 1}+${Math.floor(width / 4) + 1}+${Math.floor(height / 4) + 1}`,
      note: "unaligned",
    },
    { spec: `${width}x${height}+0+0`, note: "whole image" },
    { spec: `${halfWidth}x${halfHeight}-8-16`, note: "negative offsets" },
    { spec: `${halfWidth}x${halfHeight}`, note: "offsets omitted" },
    { spec: `8x8f+2+3`, note: "force suffix" },
  ];
}

const transforms: TransformCase[] = [
  { name: "crop only", transform: TRANSFORM.none, args: [] },
  { name: "crop + rotate 90", transform: TRANSFORM.rotate90, args: ["-rotate", "90"] },
  { name: "crop + flip h", transform: TRANSFORM.flipHorizontal, args: ["-flip", "horizontal"] },
];

const files = [
  { name: "lenna", path: sample },
  ...(existsSync(FIXTURES)
    ? [
        { name: "420", path: join(FIXTURES, "base/pattern-64x48-420.jpg") },
        { name: "422", path: join(FIXTURES, "base/pattern-64x48-422.jpg") },
        { name: "444", path: join(FIXTURES, "base/pattern-64x48-444.jpg") },
      ].filter((file) => existsSync(file.path))
    : []),
];

if (!existsSync(FIXTURES)) {
  console.log(`note: no subsampling fixtures at ${FIXTURES}, testing the bundled sample only\n`);
}

for (const file of files) {
  const input = readFileSync(file.path);
  const { width, height } = dimensions(input);

  for (const transform of transforms) {
    for (const { spec, note } of specsFor(width, height)) {
      const name = `${file.name} ${width}x${height} ${transform.name} crop ${spec} (${note})`;
      const reference = join(work, "ref.jpg");
      const turbo = jpegtran([...transform.args, "-copy", "all", "-crop", spec, "-outfile", reference, file.path]);

      if (turbo !== 0) {
        // jpegtran refuses this combination: the region runs past the lower right corner, or it would
        // need crop extension together with a transform. The module has to refuse it the same way.
        check(`${name} rejected like jpegtran`, rejectsAsBadCrop(input, transform.transform, spec), "the module accepted it");
        continue;
      }

      try {
        compare(name, rotator.transformDetailed(input, { transform: transform.transform, copy: COPY.all, crop: spec }), readFileSync(reference));
      } catch (error) {
        check(name, false, `threw ${error instanceof Error ? error.name : "Error"} status=${String((error as TransformError).status)}: ${String(error)}`);
      }
    }
  }

  // -perfect has to behave exactly like jpegtran's
  const perfectSpec = `${Math.floor(width / 2)}x${Math.floor(height / 2)}+8+8`;
  const turboPerfect = jpegtran([
    "-perfect",
    "-copy",
    "all",
    "-crop",
    perfectSpec,
    "-outfile",
    join(work, "perfect.jpg"),
    file.path,
  ]);
  const perfectPossible = rotator.perfectPossible(input, TRANSFORM.none);
  check(
    `${file.name} -perfect agrees with jpegtran (jpegtran=${String(turboPerfect)} possible=${String(perfectPossible)})`,
    (turboPerfect === 0) === perfectPossible,
  );
}

// Crop extension: a region larger than the image is allowed without a transform (IJG pads the extra
// area), but rejected as soon as a transform is requested as well.
for (const file of files) {
  const input = readFileSync(file.path);
  const { width, height } = dimensions(input);
  const spec = `${width + 16}x${height + 16}+0+0`;
  const name = `${file.name} crop extension ${spec}`;
  const reference = join(work, "ext.jpg");

  if (jpegtran(["-copy", "all", "-crop", spec, "-outfile", reference, file.path]) !== 0) {
    check(`${name} rejected like jpegtran`, rejectsAsBadCrop(input, TRANSFORM.none, spec), "the module accepted it");
    continue;
  }
  const expected = readFileSync(reference);
  const result = rotator.transformDetailed(input, { transform: TRANSFORM.none, copy: COPY.all, crop: spec });
  compare(name, result, expected);
  check(
    `${name} requested size kept`,
    result.width === width + 16 && result.height === height + 16,
    `reported ${result.width}x${result.height}, expected ${width + 16}x${height + 16}`,
  );
}

// Invalid crop specifications must be reported as such, and jpegtran must reject them too.
const input = readFileSync(sample);
const { width, height } = dimensions(input);
const badCases: BadCase[] = [
  { spec: `${width}x${height}+16+0`, transform: TRANSFORM.none, args: [], note: "offset past the right edge" },
  {
    spec: `${width + 16}x${height}+0+0`,
    transform: TRANSFORM.rotate90,
    args: ["-rotate", "90"],
    note: "extension with a transform",
  },
  { spec: "100x100+0+0x", transform: TRANSFORM.none, args: [], note: "trailing garbage" },
  { spec: "not a spec", transform: TRANSFORM.none, args: [], note: "no digits at all" },
  { spec: "0x0+0+0", transform: TRANSFORM.none, args: [], note: "zero sized region" },
];

for (const { spec, transform, args, note } of badCases) {
  const name = `reject ${spec} (${note})`;
  const turbo = jpegtran([...args, "-copy", "all", "-crop", spec, "-outfile", join(work, "bad.jpg"), sample]);

  let thrown: unknown;
  try {
    rotator.transformDetailed(input, { transform, copy: COPY.all, crop: spec });
  } catch (error) {
    thrown = error;
  }
  check(
    name,
    thrown instanceof TransformError && thrown.status === STATUS.badCrop,
    `status=${String((thrown as TransformError)?.status)} message=${String(thrown)}`,
  );
  check(`${name} jpegtran also rejects it`, turbo !== 0, "jpegtran accepted it");
}

console.log(`passed: ${passed}   failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const failure of failures.slice(0, 30)) console.log(`  - ${failure}`);
  if (failures.length > 30) console.log(`  ... and ${failures.length - 30} more`);
}
process.exit(failed === 0 ? 0 : 1);
