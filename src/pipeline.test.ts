import { test } from "node:test";
import assert from "node:assert";
import sharp from "sharp";
import { processImage, UnsupportedImageError } from "./pipeline.js";
import { parseTransformString } from "./transform.js";

// processImage is the step shared by both entry points (GET /t/... and
// POST /transform/...), so these cover the behaviour each one relies on —
// in particular the passthrough contract, which /t/ needs in order to keep
// serving PDFs, audio and animated GIFs untouched.

function pngFixture(width = 120, height = 90): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

// A 1x1, two-frame GIF89a, written out byte by byte. Sharp can't produce
// an animated image from a still one, and this is small enough to keep
// inline instead of committing a binary fixture.
function animatedGifFixture(): Buffer {
  const header = "474946383961" + "01000100" + "F0" + "0000"; // GIF89a, 1x1, 2-colour global table
  const globalColorTable = "000000FFFFFF";
  const netscapeLoop = "21FF0B" + "4E45545343415045322E30" + "03010000" + "00";
  // Graphic control (10ms delay) + image descriptor + LZW data for one pixel.
  const frame = "21F904000A000000" + "2C000000000100010000" + "0202440100";
  return Buffer.from(header + globalColorTable + netscapeLoop + frame + frame + "3B", "hex");
}

test("applies the parsed transforms", async () => {
  const { buffer, contentType } = await processImage(
    await pngFixture(),
    parseTransformString("w_60,h_40,f_webp"),
    { onUnsupported: "error" },
  );

  assert.strictEqual(contentType, "image/webp");
  const metadata = await sharp(buffer).metadata();
  assert.strictEqual(metadata.format, "webp");
  assert.strictEqual(metadata.width, 60);
  assert.strictEqual(metadata.height, 40);
});

test("composites a watermark when one is supplied", async () => {
  const source = await pngFixture(200, 200);
  const transform = parseTransformString("w_120,h_120,f_png,wg_southeast");

  const plain = await processImage(source, transform, { onUnsupported: "error" });
  const marked = await processImage(source, transform, {
    onUnsupported: "error",
    watermark: await pngFixture(40, 40),
  });

  assert.strictEqual(marked.contentType, "image/png");
  // Same dimensions, different pixels: the watermark actually landed.
  const metadata = await sharp(marked.buffer).metadata();
  assert.strictEqual(metadata.width, 120);
  assert.strictEqual(metadata.height, 120);
  assert.ok(!marked.buffer.equals(plain.buffer), "watermarked output should differ");
});

test("passthrough returns undecodable input byte-for-byte", async () => {
  // This is what keeps GET /t/ able to serve PDFs and audio from the
  // bucket: the bytes must come back untouched, with the caller-supplied
  // content type rather than an image one.
  const input = Buffer.from("%PDF-1.4 not really a pdf");

  const { buffer, contentType } = await processImage(
    input,
    parseTransformString("w_400,f_webp"),
    { onUnsupported: "passthrough", passthroughContentType: "application/pdf" },
  );

  assert.ok(buffer.equals(input), "passthrough must not alter the bytes");
  assert.strictEqual(contentType, "application/pdf");
});

test("passthrough falls back to octet-stream with no content type given", async () => {
  const { contentType } = await processImage(
    Buffer.from("still not an image"),
    parseTransformString("w_400"),
    { onUnsupported: "passthrough" },
  );

  assert.strictEqual(contentType, "application/octet-stream");
});

test("error mode rejects undecodable input instead of passing it through", async () => {
  await assert.rejects(
    processImage(Buffer.from("not an image"), parseTransformString("w_400"), {
      onUnsupported: "error",
    }),
    UnsupportedImageError,
  );
});

test("an animated image is passed through rather than flattened", async () => {
  // Sharp would decode an animated GIF without complaining but keep only
  // the first frame, silently dropping the animation — so multi-frame input
  // takes the passthrough path even though it *is* decodable.
  const animated = animatedGifFixture();
  assert.ok(((await sharp(animated).metadata()).pages ?? 1) > 1, "fixture should be multi-frame");

  const { buffer, contentType } = await processImage(
    animated,
    parseTransformString("w_16,f_webp"),
    { onUnsupported: "passthrough", passthroughContentType: "image/gif" },
  );

  assert.ok(buffer.equals(animated), "the animation must be served untouched");
  assert.strictEqual(contentType, "image/gif");

  // And on a direct upload the same input is refused rather than flattened.
  await assert.rejects(
    processImage(animated, parseTransformString("w_16,f_webp"), { onUnsupported: "error" }),
    UnsupportedImageError,
  );
});
