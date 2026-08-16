import sharp from "sharp";

const WATERMARK_GRAVITIES = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
  "center",
] as const;
type WatermarkGravity = (typeof WATERMARK_GRAVITIES)[number];

export interface ParsedTransform {
  width?: number;
  height?: number;
  format?: "webp" | "avif" | "jpeg" | "png";
  quality?: number;
  bgRemove?: boolean;
  crop?: "fill" | "fit";
  watermark?: string;
  watermarkGravity?: WatermarkGravity;
  watermarkScale?: number;
  watermarkOpacity?: number;
}

/**
 * Parses a transform segment like "w_400,h_300,f_webp,q_80"
 * (same syntax idea as Cloudinary/Openinary) into a typed object.
 */
export function parseTransformString(raw: string): ParsedTransform {
  const result: ParsedTransform = {};

  for (const part of raw.split(",")) {
    if (part === "bg_remove") {
      result.bgRemove = true;
      continue;
    }

    // Only split on the first "_": the value itself may contain more
    // underscores (e.g. the filename in "wm_my_logo.png").
    const separatorIndex = part.indexOf("_");
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex);
    const value = part.slice(separatorIndex + 1);
    if (!key || !value) continue;

    switch (key) {
      case "w":
        result.width = parseInt(value, 10);
        break;
      case "h":
        result.height = parseInt(value, 10);
        break;
      case "f":
        if (["webp", "avif", "jpeg", "png"].includes(value)) {
          result.format = value as ParsedTransform["format"];
        }
        break;
      case "q":
        result.quality = parseInt(value, 10);
        break;
      case "c":
        if (value === "fill" || value === "fit") {
          result.crop = value;
        }
        break;
      case "wm":
        result.watermark = value;
        break;
      case "wg":
        if ((WATERMARK_GRAVITIES as readonly string[]).includes(value)) {
          result.watermarkGravity = value as WatermarkGravity;
        }
        break;
      case "ws": {
        // Watermark scale, as a percentage of the result's width (1-100).
        const scale = parseInt(value, 10);
        if (!Number.isNaN(scale) && scale >= 1 && scale <= 100) {
          result.watermarkScale = scale;
        }
        break;
      }
      case "wo": {
        // Watermark opacity, as a percentage (1-100).
        const opacity = parseInt(value, 10);
        if (!Number.isNaN(opacity) && opacity >= 1 && opacity <= 100) {
          result.watermarkOpacity = opacity;
        }
        break;
      }
    }
  }

  return result;
}

// Sharp can "process" an animated GIF or other multi-frame format without
// throwing, but it only keeps the first frame and loses the animation.
// In those cases it's better to treat it like an unsupported format
// (passthrough) instead of silently returning a static image.
export async function isAnimated(input: Buffer): Promise<boolean> {
  const metadata = await sharp(input).metadata();
  return (metadata.pages ?? 1) > 1;
}

const DEFAULT_WATERMARK_OPACITY = 0.6;
const DEFAULT_WATERMARK_WIDTH_RATIO = 0.2;

function fadeAlpha(rgba: Buffer, opacity: number): Buffer {
  const out = Buffer.from(rgba);
  for (let i = 3; i < out.length; i += 4) {
    out[i] = Math.round(out[i] * opacity);
  }
  return out;
}

/**
 * Applies the transforms to an input image buffer and returns the
 * processed buffer plus the output content type.
 */
export async function applyTransform(
  input: Buffer,
  transform: ParsedTransform,
  watermark?: Buffer,
): Promise<{ buffer: Buffer; contentType: string }> {
  let pipeline = sharp(input);

  if (transform.width || transform.height) {
    // c_fill (default): crops to fill exactly w x h.
    // c_fit: keeps the whole image, fitting it within w x h.
    const fit = transform.crop === "fit" ? "inside" : "cover";
    pipeline = pipeline.resize({
      width: transform.width,
      height: transform.height,
      fit,
    });
  }

  if (watermark) {
    const base = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    // ws_ (1-100) overrides the default width ratio; wo_ (1-100) overrides
    // the default opacity. Both are optional and fall back to sensible
    // defaults so existing wm_ usages keep working unchanged.
    const widthRatio = (transform.watermarkScale ?? DEFAULT_WATERMARK_WIDTH_RATIO * 100) / 100;
    const opacity = (transform.watermarkOpacity ?? DEFAULT_WATERMARK_OPACITY * 100) / 100;

    const watermarkWidth = Math.max(1, Math.round(base.info.width * widthRatio));
    const resizedWatermark = await sharp(watermark)
      .resize({ width: watermarkWidth })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    pipeline = sharp(base.data, {
      raw: { width: base.info.width, height: base.info.height, channels: 4 },
    }).composite([
      {
        input: fadeAlpha(resizedWatermark.data, opacity),
        raw: {
          width: resizedWatermark.info.width,
          height: resizedWatermark.info.height,
          channels: 4,
        },
        gravity: transform.watermarkGravity ?? "northwest",
      },
    ]);
  }

  const format = transform.format ?? "webp";
  const quality = transform.quality ?? 80;

  switch (format) {
    case "webp":
      pipeline = pipeline.webp({ quality });
      break;
    case "avif":
      pipeline = pipeline.avif({ quality });
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({ quality });
      break;
    case "png":
      pipeline = pipeline.png();
      break;
  }

  const buffer = await pipeline.toBuffer();
  const contentType = `image/${format}`;

  return { buffer, contentType };
}
