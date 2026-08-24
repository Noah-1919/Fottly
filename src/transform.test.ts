import { test } from "node:test";
import assert from "node:assert";
import { parseTransformString } from "./transform.js";

test("parseTransformString validates quality parameter q_", () => {
  assert.strictEqual(parseTransformString("q_80").quality, 80);
  assert.strictEqual(parseTransformString("q_1").quality, 1);
  assert.strictEqual(parseTransformString("q_100").quality, 100);
  assert.strictEqual(parseTransformString("q_abc").quality, undefined);
  assert.strictEqual(parseTransformString("q_0").quality, undefined);
  assert.strictEqual(parseTransformString("q_101").quality, undefined);
  assert.strictEqual(parseTransformString("q_-10").quality, undefined);
});

test("parseTransformString parses w_ and h_ as integers", () => {
  assert.strictEqual(parseTransformString("w_400").width, 400);
  assert.strictEqual(parseTransformString("h_300").height, 300);
  const both = parseTransformString("w_400,h_300");
  assert.strictEqual(both.width, 400);
  assert.strictEqual(both.height, 300);
});

test("parseTransformString validates the f_ format", () => {
  assert.strictEqual(parseTransformString("f_webp").format, "webp");
  assert.strictEqual(parseTransformString("f_avif").format, "avif");
  assert.strictEqual(parseTransformString("f_jpeg").format, "jpeg");
  assert.strictEqual(parseTransformString("f_png").format, "png");
  assert.strictEqual(parseTransformString("f_tiff").format, "tiff");
  // Unknown format: ignored, not set.
  assert.strictEqual(parseTransformString("f_bmp").format, undefined);
});

test("parseTransformString validates the c_ crop mode", () => {
  assert.strictEqual(parseTransformString("c_fill").crop, "fill");
  assert.strictEqual(parseTransformString("c_fit").crop, "fit");
  assert.strictEqual(parseTransformString("c_bogus").crop, undefined);
});

test("parseTransformString combines w_/h_/f_/q_/c_ together", () => {
  const result = parseTransformString("w_800,h_600,f_avif,q_75,c_fit");
  assert.deepStrictEqual(result, {
    width: 800,
    height: 600,
    format: "avif",
    quality: 75,
    crop: "fit",
  });
});

test("parseTransformString treats bg_remove as a simple flag", () => {
  assert.strictEqual(parseTransformString("bg_remove").bgRemove, true);
  assert.strictEqual(parseTransformString("w_400,bg_remove").bgRemove, true);
  assert.strictEqual(parseTransformString("w_400").bgRemove, undefined);
});

test("parseTransformString treats grayscale as a simple flag", () => {
  assert.strictEqual(parseTransformString("grayscale").grayscale, true);
  assert.strictEqual(parseTransformString("w_400,grayscale,f_webp").grayscale, true);
  assert.strictEqual(parseTransformString("w_400").grayscale, undefined);
});

test("parseTransformString parses the r_ rotation as an integer, any value", () => {
  assert.strictEqual(parseTransformString("r_90").rotate, 90);
  assert.strictEqual(parseTransformString("r_180").rotate, 180);
  assert.strictEqual(parseTransformString("r_270").rotate, 270);
  // Arbitrary angles are accepted too (not restricted to multiples of 90).
  assert.strictEqual(parseTransformString("r_45").rotate, 45);
  assert.strictEqual(parseTransformString("r_abc").rotate, undefined);
});

test("parseTransformString parses watermark parameters wm_/wg_/ws_/wo_", () => {
  const result = parseTransformString("wm_logo.png,wg_center,ws_35,wo_90");
  assert.strictEqual(result.watermark, "logo.png");
  assert.strictEqual(result.watermarkGravity, "center");
  assert.strictEqual(result.watermarkScale, 35);
  assert.strictEqual(result.watermarkOpacity, 90);
});

test("parseTransformString keeps underscores in the watermark filename", () => {
  // Only the first "_" is a separator; the rest belongs to the value.
  assert.strictEqual(parseTransformString("wm_my_logo.png").watermark, "my_logo.png");
});

test("parseTransformString rejects an invalid watermark gravity", () => {
  assert.strictEqual(parseTransformString("wg_upsidedown").watermarkGravity, undefined);
});

test("parseTransformString rejects out-of-range ws_/wo_ values", () => {
  assert.strictEqual(parseTransformString("ws_0").watermarkScale, undefined);
  assert.strictEqual(parseTransformString("ws_101").watermarkScale, undefined);
  assert.strictEqual(parseTransformString("wo_0").watermarkOpacity, undefined);
  assert.strictEqual(parseTransformString("wo_101").watermarkOpacity, undefined);
});

test("parseTransformString safely ignores malformed input", () => {
  // Empty string: no segments to parse, empty result.
  assert.deepStrictEqual(parseTransformString(""), {});
  // Unknown key: no matching switch case, ignored.
  assert.deepStrictEqual(parseTransformString("zz_400"), {});
  // Key with no value (trailing underscore, nothing after it): skipped.
  assert.deepStrictEqual(parseTransformString("w_"), {});
  // Segment with no underscore at all: skipped.
  assert.deepStrictEqual(parseTransformString("garbage"), {});
  // A mix of valid and invalid segments: only the valid one is kept.
  assert.deepStrictEqual(parseTransformString("zz_400,w_800"), { width: 800 });
});
