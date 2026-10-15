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
