#!/usr/bin/env node
/**
 * A very small, jpegtran-compatible command line front end for the WebAssembly module.
 *
 * It exists to try the module out and to compare it against the system `jpegtran`:
 *
 *   node cli.ts -rotate 90 -copy all -outfile out.jpg in.jpg
 *   node cli.ts -crop 200x150+100+50 in.jpg > out.jpg
 *
 * Like jpegtran, the input is read from the given file or from stdin, and the result goes to stdout
 * unless `-outfile` is given. Switch names may be abbreviated to any unique prefix. Switches that
 * jpegtran has but this module does not implement (recompression and metadata editing) are reported
 * as unsupported rather than ignored.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { COPY, TRANSFORM, TransformError, createRotator } from "../index.js";
/** Every switch this front end understands. */
const SWITCHES = ["copy", "crop", "flip", "rotate", "transpose", "transverse", "perfect", "outfile", "version", "help"];
/** jpegtran switches that would need recompression or metadata editing, which the module does not do. */
const UNSUPPORTED = [
    "arithmetic",
    "debug",
    "drop",
    "grayscale",
    "maxmemory",
    "optimize",
    "progressive",
    "restart",
    "scans",
    "trim",
    "verbose",
    "wipe",
];
const FLIP_OPTIONS = ["horizontal", "vertical"];
const USAGE = `usage: jpegtran-js [switches] [inputfile]

Switches (names may be abbreviated, as with jpegtran):
  -copy none|comments|all   Copy extra markers (default: comments)
  -crop WxH+X+Y             Crop to a rectangular subarea
  -flip horizontal|vertical Flip the image
  -rotate 90|180|270        Rotate the image clockwise
  -transpose                Transpose the image (across the UL-to-LR axis)
  -transverse               Transverse transpose the image (across the UR-to-LL axis)
  -perfect                  Fail if there is any non-transformable edge block
  -outfile name             Write the result to name instead of stdout
  -version                  Print the libjpeg version the module was built from
  -help                     Print this message

If no input file is given, the image is read from stdin.

Unsupported jpegtran switches: ${UNSUPPORTED.join(", ")}.
`;
/** Prints a message to stderr and exits with failure. */
function fail(message) {
    process.stderr.write(`jpegtran-js: ${message}\n`);
    process.exit(1);
}
/** Matches a switch or value name against a set of names, allowing any unique prefix. */
function matchName(value, names) {
    const normalized = value.replace(/^--?/, "").toLowerCase();
    const matches = names.filter((name) => name.startsWith(normalized));
    return matches.length === 1 ? matches[0] : null;
}
/** Parses the command line, mirroring jpegtran's switches where the module can honour them. */
function parseArguments(argv) {
    const options = {
        input: null,
        outfile: null,
        transform: TRANSFORM.none,
        copy: COPY.comments, // jpegtran's default
        perfect: false,
        crop: null,
        version: false,
    };
    /** Reads the value that belongs to a switch. */
    const valueFor = (switchName, index) => {
        const value = argv[index + 1];
        if (value === undefined) {
            fail(`switch '-${switchName}' requires a value`);
        }
        return value;
    };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (!argument.startsWith("-") || argument === "-") {
            if (options.input !== null) {
                fail(`too many input files ('${options.input}' and '${argument}')`);
            }
            options.input = argument;
            continue;
        }
        if (argument === "--help" || argument === "-?") {
            process.stdout.write(USAGE);
            process.exit(0);
        }
        const unsupported = matchName(argument, UNSUPPORTED);
        if (unsupported !== null) {
            fail(`switch '-${unsupported}' is not supported (the module never recompresses)`);
        }
        const switchName = matchName(argument, SWITCHES);
        if (switchName === null) {
            fail(`unrecognized switch '${argument}'`);
        }
        switch (switchName) {
            case "help":
                process.stdout.write(USAGE);
                process.exit(0);
            case "version":
                options.version = true;
                break;
            case "outfile":
                options.outfile = valueFor(switchName, index++);
                break;
            case "crop":
                options.crop = valueFor(switchName, index++);
                break;
            case "perfect":
                options.perfect = true;
                break;
            case "rotate": {
                const degrees = valueFor(switchName, index++);
                const rotation = degrees === "90" ? TRANSFORM.rotate90 : degrees === "180" ? TRANSFORM.rotate180 : degrees === "270" ? TRANSFORM.rotate270 : null;
                if (rotation === null) {
                    fail(`'-rotate' needs 90, 180 or 270, got '${degrees}'`);
                }
                options.transform = rotation;
                break;
            }
            case "flip": {
                const direction = matchName(valueFor(switchName, index++), FLIP_OPTIONS);
                if (direction === null) {
                    fail(`'-flip' needs 'horizontal' or 'vertical'`);
                }
                options.transform = direction === "horizontal" ? TRANSFORM.flipHorizontal : TRANSFORM.flipVertical;
                break;
            }
            case "transpose":
                options.transform = TRANSFORM.transpose;
                break;
            case "transverse":
                options.transform = TRANSFORM.transverse;
                break;
            case "copy": {
                const mode = valueFor(switchName, index++);
                const copy = matchName(mode, ["none", "comments", "all"]);
                if (copy === null) {
                    fail(`'-copy' needs 'none', 'comments' or 'all', got '${mode}'`);
                }
                options.copy = copy === "none" ? COPY.none : copy === "comments" ? COPY.comments : COPY.all;
                break;
            }
            default:
                fail(`unrecognized switch '${argument}'`);
        }
    }
    return options;
}
/** Reads the input image, from the named file or from stdin. */
function readInput(input) {
    if (input === null) {
        return new Uint8Array(readFileSync(0));
    }
    try {
        return new Uint8Array(readFileSync(input));
    }
    catch (error) {
        fail(`cannot read '${input}': ${error instanceof Error ? error.message : String(error)}`);
    }
}
/** Writes the result to the named file or to stdout. */
function writeOutput(outfile, data) {
    if (outfile === null) {
        process.stdout.write(data);
        return;
    }
    try {
        writeFileSync(outfile, data);
    }
    catch (error) {
        fail(`cannot write '${outfile}': ${error instanceof Error ? error.message : String(error)}`);
    }
}
const options = parseArguments(process.argv.slice(2));
const rotator = await createRotator();
if (options.version) {
    process.stdout.write(`jpegtran-js: IJG libjpeg ${rotator.version()}\n`);
    process.exit(0);
}
try {
    const result = rotator.transformDetailed(readInput(options.input), {
        transform: options.transform,
        copy: options.copy,
        perfect: options.perfect,
        crop: options.crop,
    });
    writeOutput(options.outfile, result.data);
}
catch (error) {
    if (error instanceof TransformError) {
        fail(error.message);
    }
    fail(error instanceof Error ? error.message : String(error));
}
