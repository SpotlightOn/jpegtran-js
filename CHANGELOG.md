# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-10-15

### Added
- WebAssembly build of IJG libjpeg 10 + transupp.c providing lossless transforms in memory.
- `mv_jpeg_transform_full()` exposes crop and reports output dimensions.
- TypeScript API: `createRotator`, `JpegTransformer`, `TRANSFORM`, `COPY`, `STATUS`, `TransformError`, plus `transformDetailed()`, `crop()`, `rotate()`, `perfectPossible()`, `version()`, `transform()`.
- jpegtran-compatible CLI `jpegtran-js` (subset: rotate/flip/transpose/transverse, crop, copy, perfect, outfile, version, help).
- Build script downloads `jpegsr10.zip` from ijg.org if missing, extracts into `jpeg/`, normalises CRLF line endings and permissions.
- Tests: `test.ts` (differential against system jpegtran/djpeg), `test/simple.ts` (smoke test), `test/crop.ts` (differential against `jpegtran -crop`, crop extension and iMCU semantics).
- LICENSE (IJG licence text verbatim), API docs in `docs/api.md`.

### Changed
- Migrated to native TypeScript (`.ts`) with type checking via `tsc`; Node runs files directly with type stripping.
- Expanded packaging metadata for publishing.

## [Unreleased]

### Added
- Type declarations are generated from `src/index.ts` and shipped as `dist/index.d.ts`, referenced by
  the `types` field and by the `exports` map.

### Changed
- Sources moved to `src/` and all build output to `dist/`: `dist/index.js`, `dist/index.d.ts` and
  `dist/cli.js` (the `jpegtran-js` binary), next to the WebAssembly files. Nothing generated is
  committed any more; the whole of `dist/` is in `.gitignore`.
- `files` in `package.json` now lists `dist` and `src/jpegtran_wrapper.c`, so no `.ts` file is part of
  the published package while the C source still ships.
- The fixture corpus in `test/fixtures/` was reduced to eight curated files that cover 4:2:0 / 4:2:2 /
  4:4:4, baseline and progressive, MCU-aligned and not, with and without Exif, plus a non-JPEG input.
  The AVIF fixtures and the Exif/orientation fixtures, which no test referenced, were removed.
- `test/crop.ts` now takes its subsampling fixtures from the local `test/fixtures`, so the 4:2:2 and
  4:4:4 crop coverage also runs in CI instead of only where a sibling corpus happens to exist.
- Fixed stale references: `node cli.ts` in the CLI help, and the `.mjs` file names in the README.

