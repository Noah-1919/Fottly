import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createHash } from "node:crypto";
import { parseTransformString, applyTransform, isAnimated } from "./transform.js";
import {
  getObject,
  getObjectWithContentType,
  putObject,
  objectExists,
  deleteObject,
  copyObject,
  listKeys,
} from "./storage.js";
import { requireApiKey } from "./auth.js";
import { removeBackground } from "./rembg.js";

// Source images and the result cache live in an S3-compatible bucket
// (AWS S3 / Cloudflare R2 / MinIO), configured via environment variables
// (see src/storage.ts). The cache for a file "foo.jpg" is stored under
// "cache/foo.jpg/<hash-of-the-transforms>", so it can all be wiped in one
// go when that file is deleted or renamed.
const CACHE_PREFIX = "cache/";

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  gif: "image/gif",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
  json: "application/json",
};

function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return (ext && EXTENSION_CONTENT_TYPES[ext]) || "application/octet-stream";
}

const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 25);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 100);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);

function cacheKeyFor(filename: string, transforms: string): string {
  const hash = createHash("sha1").update(transforms).digest("hex");
  return `${CACHE_PREFIX}${encodeURIComponent(filename)}/${hash}`;
}

async function deleteCacheFor(filename: string): Promise<void> {
  const prefix = `${CACHE_PREFIX}${encodeURIComponent(filename)}/`;
  const keys = await listKeys(prefix);
  await Promise.all(keys.map((key) => deleteObject(key)));
}

const fastify = Fastify({
  logger: true,
  bodyLimit: MAX_UPLOAD_SIZE_MB * 1024 * 1024,
});

// CORS open to any origin: for local development/demo purposes only.
await fastify.register(cors, { origin: "*" });

// Global rate limit, keyed by IP by default. Must be awaited: otherwise the
// plugin's hooks aren't fully attached by the time the server starts
// accepting connections, and requests silently bypass the limit.
await fastify.register(rateLimit, {
  max: RATE_LIMIT_MAX,
  timeWindow: RATE_LIMIT_WINDOW_MS,
});

// Accepts raw file uploads with any Content-Type (falls back to the
// default JSON parser for "application/json", used by PUT /files/*).
fastify.addContentTypeParser("*", { parseAs: "buffer" }, (_request, payload, done) => {
  done(null, payload);
});

fastify.addHook("onRequest", requireApiKey);

fastify.get("/", async (_request, reply) => {
  const redirectUrl = process.env.ROOT_REDIRECT_URL;
  if (redirectUrl) {
    return reply.redirect(redirectUrl);
  }
  return { message: "Fottly API is running. Docs: https://github.com/Noah-1919/Fottly" };
});

fastify.get("/health", async () => {
  return { status: "ok" };
});

// Usage example: GET /t/w_400,h_300,f_webp/photo.jpg
fastify.get("/t/:transforms/*", async (request, reply) => {
  const { transforms } = request.params as { transforms: string };
  // Fastify's wildcard "*" arrives as request.params["*"]
  const filename = (request.params as Record<string, string>)["*"];

  if (!filename) {
    return reply.status(400).send({ error: "Missing filename" });
  }

  if (!(await objectExists(filename))) {
    return reply.status(404).send({ error: `Image not found: ${filename}` });
  }

  const parsedTransform = parseTransformString(transforms);
  const cacheObjectKey = cacheKeyFor(filename, transforms);

  if (await objectExists(cacheObjectKey)) {
    const { buffer: cached, contentType } = await getObjectWithContentType(cacheObjectKey);
    return reply.type(contentType ?? "application/octet-stream").send(cached);
  }

  let input = await getObject(filename);

  // bg_remove is applied to the original image, before resizing/converting
  // format: the cutout comes out with better quality at full resolution,
  // and the resize step only has to downscale the already-processed result.
  if (parsedTransform.bgRemove) {
    try {
      input = await removeBackground(input);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(502).send({ error: "Could not remove the image background" });
    }
  }

  let watermarkBuffer: Buffer | undefined;
  if (parsedTransform.watermark) {
    if (!(await objectExists(parsedTransform.watermark))) {
      return reply.status(400).send({
        error: `Watermark image not found: ${parsedTransform.watermark}`,
      });
    }
    watermarkBuffer = await getObject(parsedTransform.watermark);
  }

  let buffer: Buffer;
  let contentType: string;
  try {
    // An animated GIF (or other multi-frame format) doesn't throw in Sharp,
    // but it would end up keeping only the first frame: treat it as a
    // passthrough instead of silently returning a static image.
    if (await isAnimated(input)) {
      throw new Error("Animated/multi-frame format, serving without transforming");
    }
    const result = await applyTransform(input, parsedTransform, watermarkBuffer);
    buffer = result.buffer;
    contentType = result.contentType;
  } catch (err) {
    // Sharp couldn't process the file (or it's animated/PDF/audio/etc.):
    // serve it as-is instead of failing.
    fastify.log.warn({ err, filename }, "Could not transform file, serving passthrough");
    buffer = input;
    contentType = guessContentType(filename);
  }

  await putObject(cacheObjectKey, buffer, contentType);

  return reply.type(contentType).send(buffer);
});

// Uploads a file as a raw binary body. The Content-Type header is stored
// as-is; if a file with the same name already exists, its derived cache is
// cleared so stale transforms of the old content aren't served afterwards.
fastify.post("/files/*", async (request, reply) => {
  const filename = (request.params as Record<string, string>)["*"];
  if (!filename) {
    return reply.status(400).send({ error: "Missing filename" });
  }

  const body = request.body;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    return reply.status(400).send({ error: "Missing file body" });
  }

  const contentType = (request.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();

  await putObject(filename, body, contentType);
  await deleteCacheFor(filename);

  return reply.status(201).send({ uploaded: filename });
});

// Deletes a file from the bucket along with all its derived cache entries.
fastify.delete("/files/*", async (request, reply) => {
  const filename = (request.params as Record<string, string>)["*"];
  if (!filename) {
    return reply.status(400).send({ error: "Missing filename" });
  }

  if (!(await objectExists(filename))) {
    return reply.status(404).send({ error: `Image not found: ${filename}` });
  }

  await deleteObject(filename);
  await deleteCacheFor(filename);

  return reply.send({ deleted: filename });
});

// Renames/moves a file. Body: { "newFilename": "new-name.jpg" }
fastify.put("/files/*", async (request, reply) => {
  const filename = (request.params as Record<string, string>)["*"];
  if (!filename) {
    return reply.status(400).send({ error: "Missing filename" });
  }

  const { newFilename } = (request.body ?? {}) as { newFilename?: string };
  if (!newFilename) {
    return reply.status(400).send({ error: "Missing 'newFilename' in body" });
  }

  if (!(await objectExists(filename))) {
    return reply.status(404).send({ error: `Image not found: ${filename}` });
  }

  await copyObject(filename, newFilename);
  await deleteObject(filename);
  await deleteCacheFor(filename);

  return reply.send({ renamed: { from: filename, to: newFilename } });
});

async function start() {
  try {
    await fastify.listen({ port: 3000, host: "0.0.0.0" });
    console.log("Server running at http://localhost:3000");
    console.log("Try: http://localhost:3000/t/w_400,h_300,f_webp/your-image.jpg");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
