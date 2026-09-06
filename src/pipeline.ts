import { applyTransform, isAnimated, type ParsedTransform } from "./transform.js";
import { removeBackground } from "./rembg.js";

// The image processing pipeline, shared by both entry points:
//   - GET /t/:transforms/*        (source read from the S3 bucket)
//   - POST /transform/:transforms (source uploaded in the request body)
// Both must apply exactly the same steps in the same order, so the logic
// lives here instead of being duplicated in each route handler.

// Thrown when Rembg is unreachable or fails. Routes map it to 502: it's a
// failure of an upstream service, not of the caller's request.
export class BackgroundRemovalError extends Error {
  constructor(cause: unknown) {
    super("Could not remove the image background");
    this.name = "BackgroundRemovalError";
    this.cause = cause;
  }
}

// Thrown when Sharp can't decode the input (corrupt file, or a format it
// doesn't handle) and the caller asked for "error" instead of passthrough.
export class UnsupportedImageError extends Error {
  constructor(cause: unknown) {
    super("The file could not be processed as an image");
    this.name = "UnsupportedImageError";
    this.cause = cause;
  }
}

// What to do when Sharp can't process the input. The two entry points
// genuinely differ here:
//   - "passthrough": serve the original bytes untouched. Correct for /t/,
//     where the bucket also holds PDFs, SVGs, audio and animated GIFs that
//     are expected to be delivered as-is.
//   - "error": reject with a 4xx. Correct for direct uploads, where echoing
//     the caller's own file back at them with a 200 would hide the problem.
export type UnsupportedBehavior = "passthrough" | "error";

interface Logger {
  warn(obj: unknown, msg: string): void;
}

export interface ProcessImageOptions {
  // Already-resolved watermark image. Resolving it is the caller's job:
  // /t/ reads it from the bucket, the upload route takes it from a second
  // multipart field, so the pipeline never needs to know about storage.
  watermark?: Buffer;
  onUnsupported: UnsupportedBehavior;
  // Content type to report when falling back to passthrough. Only used
  // when onUnsupported is "passthrough".
  passthroughContentType?: string;
  log?: Logger;
}

export async function processImage(
  input: Buffer,
  transform: ParsedTransform,
  options: ProcessImageOptions,
): Promise<{ buffer: Buffer; contentType: string }> {
  let image = input;

  // bg_remove is applied to the original image, before resizing/converting
  // format: the cutout comes out with better quality at full resolution,
  // and the resize step only has to downscale the already-processed result.
  if (transform.bgRemove) {
    try {
      image = await removeBackground(image);
    } catch (err) {
      throw new BackgroundRemovalError(err);
    }
  }

  try {
    // An animated GIF (or other multi-frame format) doesn't throw in Sharp,
    // but it would end up keeping only the first frame: treat it as a
    // passthrough instead of silently returning a static image.
    if (await isAnimated(image)) {
      throw new Error("Animated/multi-frame format, serving without transforming");
    }
    return await applyTransform(image, transform, options.watermark);
  } catch (err) {
    if (options.onUnsupported === "error") {
      throw new UnsupportedImageError(err);
    }
    // Sharp couldn't process the file (or it's animated/PDF/audio/etc.):
    // serve it as-is instead of failing.
    options.log?.warn({ err }, "Could not transform file, serving passthrough");
    // "image", not "input": if bg_remove already ran, the passthrough keeps
    // that result rather than throwing it away.
    return {
      buffer: image,
      contentType: options.passthroughContentType ?? "application/octet-stream",
    };
  }
}
