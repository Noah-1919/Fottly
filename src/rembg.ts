import sharp from "sharp";

// Client for the Rembg service (background removal), run as a separate
// service in docker-compose. The danielgatis/rembg image exposes, in
// server mode ("rembg s"), an HTTP POST /api/remove endpoint that takes
// the file as multipart/form-data and returns the resulting PNG with the
// background already removed (transparent).
const REMBG_URL = process.env.REMBG_URL ?? "http://rembg:7000";
const REMBG_TIMEOUT_MS = 60_000;

// isnet-general-use + alpha matting gives noticeably better edges than the
// default model (u2net) on thin structures (legs, fingers, feathers):
// tested with a real image where u2net cut off both legs of the subject
// and isnet-general-use kept them. birefnet-general (~1GB) was also tried
// but crashed the container from lack of memory (OOMKilled), so it was
// ruled out despite being more accurate in theory.
const REMBG_MODEL = "isnet-general-use";

// Alpha matting scales poorly with resolution: in real testing, a
// 4000x3000 (12MP) photo crashed the container from lack of memory
// (OOMKilled), while a ~700px image worked fine. The longer side is
// capped before sending the image to Rembg to avoid the OOM; the
// sharpness of the cutout isn't noticeably affected.
const REMBG_MAX_DIMENSION = 1600;

async function capDimensions(input: Buffer, maxDimension: number): Promise<Buffer> {
  const { width, height } = await sharp(input).metadata();
  if (!width || !height || Math.max(width, height) <= maxDimension) {
    return input;
  }
  return sharp(input).resize({ width: maxDimension, height: maxDimension, fit: "inside" }).toBuffer();
}

export async function removeBackground(input: Buffer): Promise<Buffer> {
  const capped = await capDimensions(input, REMBG_MAX_DIMENSION);

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(capped)]), "input");
  formData.append("model", REMBG_MODEL);
  formData.append("a", "true"); // alpha matting: improves fine edges

  let response: Response;
  try {
    response = await fetch(`${REMBG_URL}/api/remove`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(REMBG_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach the Rembg service: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Rembg responded with error ${response.status}: ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
