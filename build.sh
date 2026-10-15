#!/bin/sh
#
# Builds the lossless JPEG transform module for WebAssembly.
#
# The libjpeg sources (release 10) are taken from, in this order:
#
#   1. a build tree that is already there under jpeg/,
#   2. the source tree given in JPEG_SRC,
#   3. the official release archive, which is downloaded from ijg.org into jpegsr10.zip and
#      unpacked under jpeg/.
#
# Output: dist/jpegtran.mjs + dist/jpegtran.wasm
#
# Requires Emscripten in PATH. The script tries to locate it in this order:
#   1. Already in PATH (e.g. from emscripten-core/setup-emsdk@v2 with activate: true)
#   2. EMSDK environment variable (set by the setup-emsdk action)
#   3. Common system locations
#
set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Try to locate Emscripten.
# First, check if emcc is already in PATH (e.g. from GitHub Actions setup-emsdk action).
if ! command -v emcc >/dev/null 2>&1; then
  # If EMSDK is set (by setup-emsdk action), source its environment.
  if [ -n "${EMSDK:-}" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
    . "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
  fi
fi
if ! command -v emcc >/dev/null 2>&1 && [ -f /etc/profile.d/emscripten.sh ]; then
  . /etc/profile.d/emscripten.sh
fi
if ! command -v emcc >/dev/null 2>&1 && [ -f /usr/share/emscripten/emsdk_env.sh ]; then
  . /usr/share/emscripten/emsdk_env.sh >/dev/null 2>&1
fi
if ! command -v emcc >/dev/null 2>&1 && [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
  . "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
fi
# If emcc is found but emconfigure isn't in PATH, add emcc's directory to PATH.
if ! command -v emconfigure >/dev/null 2>&1 && command -v emcc >/dev/null 2>&1; then
  export PATH="$(dirname "$(command -v emcc)"):$PATH"
fi

: "${EMCC:=emcc}"

# Verify emcc and emconfigure are available.
if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found. Please install Emscripten or use emscripten-core/setup-emsdk@v2." >&2
  exit 1
fi
if ! command -v emconfigure >/dev/null 2>&1; then
  echo "error: emconfigure not found. Emscripten installation may be incomplete." >&2
  exit 1
fi

JPEG_DIR="$ROOT/jpeg"
JPEG_RELEASE=10
JPEG_ZIP="$ROOT/jpegsr${JPEG_RELEASE}.zip"
JPEG_URL="${JPEG_URL:-https://www.ijg.org/files/jpegsr${JPEG_RELEASE}.zip}"
JPEG_SRC="${JPEG_SRC:-}"

# Prints the directory holding the unpacked libjpeg sources, or nothing when there is none. The
# release archive unpacks into a jpeg-10/ subdirectory, a plain source tree does not.
find_source_dir() {
  for candidate in "$JPEG_DIR" "$JPEG_DIR"/jpeg-*; do
    if [ -f "$candidate/configure" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 0
}

# Downloads the release archive into the project directory so that later builds can reuse it.
download_sources() {
  if [ ! -f "$JPEG_ZIP" ]; then
    echo "==> downloading $JPEG_URL"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL -o "$JPEG_ZIP" "$JPEG_URL"
    elif command -v wget >/dev/null 2>&1; then
      wget -q -O "$JPEG_ZIP" "$JPEG_URL"
    else
      echo "error: neither curl nor wget is available to download $JPEG_URL" >&2
      exit 1
    fi
  else
    echo "==> reusing the archive already downloaded to $JPEG_ZIP"
  fi

  echo "==> unpacking $JPEG_ZIP under $JPEG_DIR"
  rm -rf "$JPEG_DIR"
  mkdir -p "$JPEG_DIR"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$JPEG_ZIP" -d "$JPEG_DIR"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
      "$JPEG_ZIP" "$JPEG_DIR"
  else
    echo "error: neither unzip nor python3 is available to unpack $JPEG_ZIP" >&2
    exit 1
  fi
}

# The IJG archive is packed for Windows: it carries no Unix permissions and every file uses CRLF
# line endings. That breaks the shebang of configure ("#!/bin/sh\r" makes execvp fail) and the
# generated makefiles, so both are fixed up here. The source tree is pure text.
prepare_source_tree() {
  if [ -f "$SOURCE_DIR/configure" ] && grep -q "$(printf '\r')" "$SOURCE_DIR/configure"; then
    echo "==> converting CRLF line endings to LF"
    find "$SOURCE_DIR" -type f -exec sed -i "s/$(printf '\r')\$//" {} +
  fi
  for script in configure config.guess config.sub install-sh ltmain.sh depcomp missing compile ar-lib; do
    if [ -f "$SOURCE_DIR/$script" ]; then
      chmod +x "$SOURCE_DIR/$script"
    fi
  done
}

SOURCE_DIR="$(find_source_dir)"

if [ -n "$SOURCE_DIR" ]; then
  echo "==> using the libjpeg sources already unpacked in $SOURCE_DIR"
elif [ -n "$JPEG_SRC" ]; then
  if [ ! -f "$JPEG_SRC/configure" ]; then
    echo "error: no libjpeg sources at $JPEG_SRC (set JPEG_SRC to a libjpeg source tree)" >&2
    exit 1
  fi
  echo "==> copying the libjpeg sources from $JPEG_SRC"
  rm -rf "$JPEG_DIR"
  cp -a "$JPEG_SRC" "$JPEG_DIR"
  SOURCE_DIR="$(find_source_dir)"
else
  download_sources
  SOURCE_DIR="$(find_source_dir)"
fi

if [ -z "$SOURCE_DIR" ] || [ ! -f "$SOURCE_DIR/configure" ]; then
  echo "error: could not find a libjpeg source tree under $JPEG_DIR" >&2
  exit 1
fi

prepare_source_tree

echo "==> building libjpeg (static, wasm)"
cd "$SOURCE_DIR"
emconfigure ./configure --disable-shared --enable-static --host=wasm32-unknown-emscripten
emmake make libjpeg.la -j"$(nproc)"
cd "$ROOT"

echo "==> linking the transform module"
mkdir -p "$ROOT/dist"
"$EMCC" \
  src/jpegtran_wrapper.c \
  "$SOURCE_DIR/transupp.c" \
  -I "$SOURCE_DIR" \
  "$SOURCE_DIR/.libs/libjpeg.a" \
  -O3 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createJpegTran \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=node,web,worker \
  -sEXPORTED_FUNCTIONS=_mv_jpeg_transform,_mv_jpeg_transform_full,_mv_jpeg_perfect_possible,_mv_free,_mv_last_message,_mv_last_msg_code,_mv_version,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,UTF8ToString \
  -o "$ROOT/dist/jpegtran.mjs"

echo "==> done"
ls -la "$ROOT/dist/"
