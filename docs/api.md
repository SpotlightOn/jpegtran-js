# API Reference

The module exports the transformer factory, constants, and a few type helpers. It is consumed directly from the generated WebAssembly module through the TypeScript wrapper in `src/index.ts`; the declarations in `dist/index.d.ts` are generated from that source.

## Loading

```ts
import { createRotator } from "@chimok/jpegtran-js";
const rotator = await createRotator();
```

`createRotator()` loads `dist/jpegtran.mjs` (and `dist/jpegtran.wasm`) and returns a `JpegTransformer` instance.

## Constants

### TRANSFORM

```ts
const TRANSFORM = {
  none: 0,
  rotate90: 1,
  rotate180: 2,
  rotate270: 3,
  flipHorizontal: 4,
  flipVertical: 5,
  transpose: 6,
  transverse: 7,
} as const;
```

### COPY

```ts
const COPY = {
  none: 0,
  comments: 1,
  all: 2, // keep Exif and every APPn marker
} as const;
```

### STATUS

```ts
const STATUS = {
  ok: 0,
  badArgument: 1,
  notJpeg: 2,
  notPerfect: 3,
  library: 4,
  badCrop: 5,
} as const;
```

## Types

- `type Transform = (typeof TRANSFORM)[keyof typeof TRANSFORM]`
- `type CopyOption = (typeof COPY)[keyof typeof COPY]`
- `interface CropRect { width: number; height: number; x?: number; y?: number; }`
- `type CropSpec = string | CropRect`
- `interface TransformOptions { transform?: Transform|number; copy?: CopyOption|number; perfect?: boolean; crop?: CropSpec|null; }`
- `interface TransformResult { data: Uint8Array; width: number; height: number; }`
- `interface RotateResult extends TransformResult { perfect: boolean; }`

Errors are thrown as `TransformError` with `status` and `msgCode`.

## JpegTransformer Methods

### version()

`version(): string` — returns the IJG libjpeg version string.

### perfectPossible(input, transform)

`perfectPossible(input: Uint8Array|ArrayBuffer, transform: Transform|number): boolean` — reports whether the transform is MCU aligned (like `jpegtran -perfect` would accept).

### transformDetailed(input, options)

`transformDetailed(input: Uint8Array|ArrayBuffer, options?: TransformOptions): TransformResult` — transforms and/or crops. Defaults: `transform=TRANSFORM.none`, `copy=COPY.all`, `perfect=false`, `crop=null`. Returns `{ data, width, height }`.

### transform(input, options)

`transform(input, options?): Uint8Array` — same as above, returns only `data`.

### crop(input, rect, options?)

`crop(input: Uint8Array|ArrayBuffer, rect: CropSpec, options?: TransformOptions): TransformResult` — lossless crop. The crop is applied after any transform given in `options`. As with `jpegtran -crop`, the upper left corner is silently moved to an iMCU boundary and the region grows to cover the request unless the `f` suffix is used (or pass the full string). Crop extension is only allowed without a transform.

### rotate(input, degrees, options?)

`rotate(input: Uint8Array|ArrayBuffer, degrees: number, options?: TransformOptions): RotateResult` — rotates by 90, 180 or 270 degrees clockwise. Returns `{ data, width, height, perfect }` where `perfect` indicates whether the transform is MCU aligned (mirrors jpegtran’s behaviour when `-perfect` is omitted).

## Notes

- All transforms are lossless in the DCT domain (no re-quantization).
- Marker copying: `COPY.all` preserves EXIF and all APPn markers. The CLI defaults to `COPY.comments` to match jpegtran.
- The crop specification accepts `jpegtran` syntax (e.g. `200x150+100+50`, `200x150-10-10`, `100x100f+0+0`). iMCU adjustments and error semantics match IJG transupp.c exactly.
