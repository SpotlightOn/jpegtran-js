/*
 * jpegtran_wrapper.c - lossless JPEG transforms (rotate/flip) as a WebAssembly API.
 *
 * Built from the Independent JPEG Group's libjpeg (release 10) together with its transupp.c
 * transform engine. The call sequence is the one jpegtran performs for
 *
 *   jpegtran -rotate 90 -perfect -copy all -outfile out.jpg in.jpg
 *
 * except that everything stays in memory (jpeg_mem_src / jpeg_mem_dest), so no filesystem and no
 * subprocess are involved. The quantized DCT coefficients are rearranged, never dequantized and
 * never requantized, so the transform is lossless.
 *
 * The public entry points are exported for Emscripten; see index.mjs for the JavaScript side.
 */

#include <setjmp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "jpeglib.h"
#include "jerror.h" /* jpeglib.h only pulls this in for JPEG_INTERNALS */
#include "jversion.h"
#include "transupp.h"

#include <emscripten/emscripten.h>

/* Defined below; used by the error unwinding path. */
EMSCRIPTEN_KEEPALIVE void mv_free(void *pointer);

/* Transform codes. Stable numbers of our own, mapped to JXFORM_CODE below. */
enum {
  MV_TRANSFORM_NONE = 0, /* no rotate/flip (jpegtran without -rotate); useful for a crop only */
  MV_ROT_90 = 1,   /* 90 degrees clockwise  (jpegtran -rotate 90)  */
  MV_ROT_180 = 2,  /* 180 degrees           (jpegtran -rotate 180) */
  MV_ROT_270 = 3,  /* 270 degrees clockwise (jpegtran -rotate 270) */
  MV_FLIP_H = 4,
  MV_FLIP_V = 5,
  MV_TRANSPOSE = 6,
  MV_TRANSVERSE = 7
};

/* Marker copy modes (jpegtran -copy). Note that the IJG default is "comments" only, so "all" has
 * to be requested explicitly to keep Exif and every other APPn marker. */
enum {
  MV_COPY_NONE = 0,
  MV_COPY_COMMENTS = 1,
  MV_COPY_ALL = 2
};

/* Return codes. */
enum {
  MV_OK = 0,
  MV_ERR_BAD_ARG = 1,
  MV_ERR_NOT_JPEG = 2,
  MV_ERR_NOT_PERFECT = 3,
  MV_ERR_LIBRARY = 4,
  MV_ERR_BAD_CROP = 5
};

#define MV_MESSAGE_MAX 256

static jmp_buf g_jmp;
static char g_message[MV_MESSAGE_MAX];
static int g_msg_code;

/* Copies a string into the message buffer; stdio is deliberately avoided. */
static void mv_set_message(const char *text) {
  size_t length = strlen(text);
  if (length >= MV_MESSAGE_MAX) {
    length = MV_MESSAGE_MAX - 1;
  }
  memcpy(g_message, text, length);
  g_message[length] = '\0';
}

/* libjpeg error handler: records the formatted message and unwinds to setjmp below. */
static void mv_error_exit(j_common_ptr cinfo) {
  g_msg_code = cinfo->err->msg_code;
  (*cinfo->err->format_message)(cinfo, g_message);
  g_message[MV_MESSAGE_MAX - 1] = '\0';
  longjmp(g_jmp, 1);
}

/* Suppresses the default stderr output; warnings are not interesting for a one-shot transform. */
static void mv_output_message(j_common_ptr cinfo) {
  (void)cinfo;
}

/* Error codes that mean "this data is not a usable JPEG file". */
static int mv_is_not_jpeg(int msg_code) {
  return msg_code == JERR_NO_SOI || msg_code == JERR_NO_IMAGE || msg_code == JERR_BAD_LENGTH;
}

/* Maps our transform number to the library code. */
static int mv_map_transform(int transform, JXFORM_CODE *out) {
  switch (transform) {
    case MV_TRANSFORM_NONE: *out = JXFORM_NONE; return 1;
    case MV_ROT_90: *out = JXFORM_ROT_90; return 1;
    case MV_ROT_180: *out = JXFORM_ROT_180; return 1;
    case MV_ROT_270: *out = JXFORM_ROT_270; return 1;
    case MV_FLIP_H: *out = JXFORM_FLIP_H; return 1;
    case MV_FLIP_V: *out = JXFORM_FLIP_V; return 1;
    case MV_TRANSPOSE: *out = JXFORM_TRANSPOSE; return 1;
    case MV_TRANSVERSE: *out = JXFORM_TRANSVERSE; return 1;
    default: return 0;
  }
}

/* Maps our copy mode to the library code. */
static int mv_map_copy(int copy_option, JCOPY_OPTION *out) {
  switch (copy_option) {
    case MV_COPY_NONE: *out = JCOPYOPT_NONE; return 1;
    case MV_COPY_COMMENTS: *out = JCOPYOPT_COMMENTS; return 1;
    case MV_COPY_ALL: *out = JCOPYOPT_ALL; return 1;
    default: return 0;
  }
}

/*
 * The "is this transform perfect?" predicate of transupp.c. It has to see the output dimensions,
 * which jpeg_core_output_dimensions() computes from the frame header.
 */
static boolean mv_is_perfect(j_decompress_ptr srcinfo, JXFORM_CODE transform) {
  jpeg_core_output_dimensions(srcinfo);
  if (srcinfo->num_components == 1) {
    return jtransform_perfect_transform(srcinfo->output_width, srcinfo->output_height,
                                        srcinfo->min_DCT_h_scaled_size,
                                        srcinfo->min_DCT_v_scaled_size, transform);
  }
  return jtransform_perfect_transform(srcinfo->output_width, srcinfo->output_height,
                                      srcinfo->max_h_samp_factor * srcinfo->min_DCT_h_scaled_size,
                                      srcinfo->max_v_samp_factor * srcinfo->min_DCT_v_scaled_size,
                                      transform);
}

/* Installs our error handling on a freshly zeroed error manager. */
static void mv_install_error_handler(struct jpeg_error_mgr *err) {
  jpeg_std_error(err);
  err->error_exit = mv_error_exit;
  err->output_message = mv_output_message;
}

/*
 * Reports whether the requested transform is perfect (MCU aligned) for the given JPEG.
 *
 * Only the header is decoded, so this is cheap and can be used to pick between "perfect" and the
 * lossy-edge behaviour before doing the real work.
 *
 * @returns MV_OK, or an error code when the data is not a JPEG.
 */
EMSCRIPTEN_KEEPALIVE
int mv_jpeg_perfect_possible(const unsigned char *in, size_t in_len, int transform, int *possible) {
  struct jpeg_decompress_struct srcinfo;
  struct jpeg_error_mgr jerr;
  JXFORM_CODE xform;
  int created = 0;

  if (in == NULL || in_len == 0 || possible == NULL) {
    return MV_ERR_BAD_ARG;
  }
  *possible = 0;
  if (!mv_map_transform(transform, &xform)) {
    return MV_ERR_BAD_ARG;
  }

  g_message[0] = '\0';
  g_msg_code = 0;
  srcinfo.err = &jerr;
  mv_install_error_handler(&jerr);

  if (setjmp(g_jmp)) {
    if (created) {
      jpeg_destroy_decompress(&srcinfo);
    }
    return mv_is_not_jpeg(g_msg_code) ? MV_ERR_NOT_JPEG : MV_ERR_LIBRARY;
  }

  jpeg_create_decompress(&srcinfo);
  created = 1;
  jpeg_mem_src(&srcinfo, in, in_len);
  (void)jpeg_read_header(&srcinfo, TRUE);

  *possible = mv_is_perfect(&srcinfo, xform) ? 1 : 0;

  jpeg_destroy_decompress(&srcinfo);
  return MV_OK;
}

/*
 * The core of the transform; both exported entry points funnel through here.
 *
 * @param crop_spec        NULL, or a crop specification in jpegtran's -crop syntax
 * @param perfect_possible optional; receives 1 when the transform is MCU aligned
 * @param out_width        optional; receives the width of the result
 * @param out_height       optional; receives the height of the result
 */
static int mv_transform_impl(const unsigned char *in, size_t in_len,
                             unsigned char **out, size_t *out_len,
                             int transform, int copy_option, int perfect,
                             const char *crop_spec,
                             int *perfect_possible,
                             unsigned int *out_width, unsigned int *out_height) {
  struct jpeg_decompress_struct srcinfo;
  struct jpeg_compress_struct dstinfo;
  struct jpeg_error_mgr jerr_src;
  struct jpeg_error_mgr jerr_dst;
  jpeg_transform_info transformoption;
  jvirt_barray_ptr *src_coef_arrays;
  jvirt_barray_ptr *dst_coef_arrays;
  JXFORM_CODE xform;
  JCOPY_OPTION copyopt;
  int src_created = 0;
  int dst_created = 0;
  int result;

  if (in == NULL || in_len == 0 || out == NULL || out_len == NULL) {
    return MV_ERR_BAD_ARG;
  }
  *out = NULL;
  *out_len = 0;
  if (perfect_possible != NULL) {
    *perfect_possible = 0;
  }
  if (out_width != NULL) {
    *out_width = 0;
  }
  if (out_height != NULL) {
    *out_height = 0;
  }
  if (!mv_map_transform(transform, &xform) || !mv_map_copy(copy_option, &copyopt)) {
    return MV_ERR_BAD_ARG;
  }

  memset(&transformoption, 0, sizeof(transformoption));
  transformoption.transform = xform;
  transformoption.perfect = perfect ? TRUE : FALSE;

  /* The crop specification is parsed by the same routine jpegtran uses, so the syntax (and the
   * silent adjustment of the crop region to iMCU boundaries) is identical. */
  if (crop_spec != NULL && !jtransform_parse_crop_spec(&transformoption, crop_spec)) {
    mv_set_message("bogus crop specification");
    return MV_ERR_BAD_CROP;
  }

  g_message[0] = '\0';
  g_msg_code = 0;

  srcinfo.err = &jerr_src;
  dstinfo.err = &jerr_dst;
  mv_install_error_handler(&jerr_src);
  mv_install_error_handler(&jerr_dst);

  if (setjmp(g_jmp)) {
    /* A libjpeg error unwound us here. */
    if (dst_created) {
      jpeg_destroy_compress(&dstinfo);
    }
    if (src_created) {
      jpeg_destroy_decompress(&srcinfo);
    }
    mv_free(*out);
    *out = NULL;
    *out_len = 0;
    if (out_width != NULL) {
      *out_width = 0;
    }
    if (out_height != NULL) {
      *out_height = 0;
    }
    if (mv_is_not_jpeg(g_msg_code)) {
      return MV_ERR_NOT_JPEG;
    }
    if (g_msg_code == JERR_BAD_CROP_SPEC) {
      return MV_ERR_BAD_CROP;
    }
    return MV_ERR_LIBRARY;
  }

  jpeg_create_decompress(&srcinfo);
  src_created = 1;
  jpeg_create_compress(&dstinfo);
  dst_created = 1;

  jpeg_mem_src(&srcinfo, in, in_len);
  jcopy_markers_setup(&srcinfo, copyopt);
  (void)jpeg_read_header(&srcinfo, TRUE);

  if (perfect_possible != NULL) {
    *perfect_possible = mv_is_perfect(&srcinfo, xform) ? 1 : 0;
  }

  /* Note that the -perfect check looks at the whole image, not at the crop region, exactly like
   * jpegtran. Fails only for -perfect with a non-MCU-aligned image. */
  if (!jtransform_request_workspace(&srcinfo, &transformoption)) {
    mv_set_message("transformation is not perfect");
    result = MV_ERR_NOT_PERFECT;
    goto cleanup;
  }

  src_coef_arrays = jpeg_read_coefficients(&srcinfo);
  jpeg_copy_critical_parameters(&srcinfo, &dstinfo);
  dst_coef_arrays = jtransform_adjust_parameters(&srcinfo, &dstinfo, src_coef_arrays,
                                                 &transformoption);

  /* jtransform_adjust_parameters has computed the final dimensions (rotation and/or crop). */
  if (out_width != NULL) {
    *out_width = (unsigned int) transformoption.output_width;
  }
  if (out_height != NULL) {
    *out_height = (unsigned int) transformoption.output_height;
  }

  jpeg_mem_dest(&dstinfo, out, out_len);
  jpeg_write_coefficients(&dstinfo, dst_coef_arrays);
  jcopy_markers_execute(&srcinfo, &dstinfo, copyopt);
  jtransform_execute_transform(&srcinfo, &dstinfo, src_coef_arrays, &transformoption);

  jpeg_finish_compress(&dstinfo);
  jpeg_destroy_compress(&dstinfo);
  dst_created = 0;
  (void)jpeg_finish_decompress(&srcinfo);
  jpeg_destroy_decompress(&srcinfo);
  src_created = 0;
  result = MV_OK;

cleanup:
  if (dst_created) {
    jpeg_destroy_compress(&dstinfo);
  }
  if (src_created) {
    jpeg_destroy_decompress(&srcinfo);
  }
  return result;
}

/*
 * Transforms a JPEG in memory.
 *
 * @param in               input buffer, must stay valid for the duration of the call
 * @param in_len           input length in bytes
 * @param out              receives a malloc'ed output buffer (release with mv_free)
 * @param out_len          receives the output length in bytes
 * @param transform        one of the MV_* transform codes
 * @param copy_option      one of the MV_COPY_* marker modes
 * @param perfect          when non-zero, refuse a transform that is not MCU aligned
 * @param perfect_possible optional; receives 1 when the transform is MCU aligned
 * @returns MV_OK, or an error code
 */
EMSCRIPTEN_KEEPALIVE
int mv_jpeg_transform(const unsigned char *in, size_t in_len,
                      unsigned char **out, size_t *out_len,
                      int transform, int copy_option, int perfect,
                      int *perfect_possible) {
  return mv_transform_impl(in, in_len, out, out_len, transform, copy_option, perfect,
                           NULL, perfect_possible, NULL, NULL);
}

/*
 * Transforms and/or crops a JPEG in memory.
 *
 * This is the general entry point; it mirrors jpegtran with -rotate, -flip, -transpose, -transverse
 * and -crop combined. Pass transform = MV_TRANSFORM_NONE for a crop without any rotation.
 *
 * @param crop_spec        NULL, or a crop specification in the syntax of jpegtran's -crop option:
 *                         width 'x' height followed by the x and y offsets, e.g. "200x150+10+20".
 *                         Every element may be omitted; offsets may be negative (measured from the
 *                         right and bottom edge); width and height may carry the suffix 'f' (force,
 *                         i.e. do not grow the region to the iMCU grid) or 'r' (reflect the edge
 *                         pixels when extending). See jtransform_parse_crop_spec().
 * @param perfect_possible optional; receives 1 when the transform is MCU aligned. Note that this
 *                         looks at the whole image, not at the crop region, like jpegtran's
 *                         -perfect.
 * @param out_width        optional; receives the width of the result
 * @param out_height       optional; receives the height of the result
 * @returns MV_OK, or an error code. MV_ERR_BAD_CROP when crop_spec cannot be parsed or describes a
 *          region outside the image.
 */
EMSCRIPTEN_KEEPALIVE
int mv_jpeg_transform_full(const unsigned char *in, size_t in_len,
                           unsigned char **out, size_t *out_len,
                           int transform, int copy_option, int perfect,
                           const char *crop_spec,
                           int *perfect_possible,
                           unsigned int *out_width, unsigned int *out_height) {
  return mv_transform_impl(in, in_len, out, out_len, transform, copy_option, perfect,
                           crop_spec, perfect_possible, out_width, out_height);
}

/* Releases a buffer returned through mv_jpeg_transform. */
EMSCRIPTEN_KEEPALIVE
void mv_free(void *pointer) {
  free(pointer);
}

/* The message of the last failing call, or an empty string. */
EMSCRIPTEN_KEEPALIVE
const char *mv_last_message(void) {
  return g_message;
}

/* The libjpeg message code (JERR_*) of the last failing call, or 0. */
EMSCRIPTEN_KEEPALIVE
int mv_last_msg_code(void) {
  return g_msg_code;
}

/* The IJG libjpeg version this module was built from. */
EMSCRIPTEN_KEEPALIVE
const char *mv_version(void) {
  return JVERSION;
}
