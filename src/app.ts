import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { createHash } from "node:crypto";
import { parseTransformString } from "./transform.js";
import {
  getObject,
  getObjectWithContentType,
  putObject,
  objectExists,
  deleteObject,
  copyObject,
  listKeys,
  isStorageConfigured,
} from "./storage.js";
import { requireApiKey } from "./auth.js";
import {
  processImage,
  BackgroundRemovalError,
  UnsupportedImageError,
} from "./pipeline.js";

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

function cacheKeyFor(filename: string, transforms: string): string {
  const hash = createHash("sha1").update(transforms).digest("hex");
  return `${CACHE_PREFIX}${encodeURIComponent(filename)}/${hash}`;
}

async function deleteCacheFor(filename: string): Promise<void> {
  const prefix = `${CACHE_PREFIX}${encodeURIComponent(filename)}/`;
  const keys = await listKeys(prefix);
  await Promise.all(keys.map((key) => deleteObject(key)));
}

const STORAGE_REQUIRED_MESSAGE =
  "S3 storage is not configured on this instance. Set S3_BUCKET (and the matching " +
  "credentials) to use the bucket-backed routes, or POST the image directly to " +
  "/transform/:transforms instead.";

// Builds the server without starting it, so tests can drive it with
// fastify.inject(). src/server.ts is the thin entrypoint that listens.
// Configuration is read here rather than at module scope so that each call
// picks up the current environment.
export async function buildServer(): Promise<FastifyInstance> {
  const maxUploadSizeMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 25);
  const maxUploadSizeBytes = maxUploadSizeMb * 1024 * 1024;
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 100);
  const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);

  const fastify = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: maxUploadSizeBytes,
  });

  // CORS open to any origin: for local development/demo purposes only.
  await fastify.register(cors, { origin: "*" });

  // Global rate limit, keyed by IP by default. Must be awaited: otherwise the
  // plugin's hooks aren't fully attached by the time the server starts
  // accepting connections, and requests silently bypass the limit.
  await fastify.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: rateLimitWindowMs,
  });

  // Multipart uploads for POST /transform/:transforms. fileSize is the real
  // memory guard: multipart bodies are consumed by busboy, not by Fastify's
  // body parser, so the pre-check on Content-Length can't be the only
  // defence — a chunked upload doesn't declare a size at all. With
  // throwFileSizeLimit on (the default), the file stream is cut off and the
  // buffered chunks discarded as soon as the cap is passed, so an oversized
  // upload can't grow past it in memory.
  //
  // Set explicitly rather than left to the plugin, which would otherwise
  // fall back to Fastify's bodyLimit: same number today, but that coupling
  // is easy to break by accident and the failure mode is an unbounded read.
  await fastify.register(multipart, {
    limits: {
      fileSize: maxUploadSizeBytes,
      files: 2, // the image itself, plus an optional watermark
      fields: 4,
    },
  });

  // Accepts raw file uploads with any Content-Type (falls back to the
  // default JSON parser for "application/json", used by PUT /files/*).
  // Registered after the multipart plugin, which installs its own parser
  // for "multipart/form-data" — an exact match wins over this catch-all.
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

    if (!isStorageConfigured()) {
      return reply.status(503).send({ error: STORAGE_REQUIRED_MESSAGE });
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

    const input = await getObject(filename);

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
      // Unsupported/animated input is served untouched here: the bucket also
      // holds PDFs, SVGs and audio that are expected to pass through.
      ({ buffer, contentType } = await processImage(input, parsedTransform, {
        watermark: watermarkBuffer,
        onUnsupported: "passthrough",
        passthroughContentType: guessContentType(filename),
        // Child logger so the passthrough warning still carries the
        // filename, which the pipeline itself has no way to know.
        log: fastify.log.child({ filename }),
      }));
    } catch (err) {
      if (err instanceof BackgroundRemovalError) {
        fastify.log.error(err);
        return reply.status(502).send({ error: err.message });
      }
      throw err;
    }

    await putObject(cacheObjectKey, buffer, contentType);

    return reply.type(contentType).send(buffer);
  });

  // Transforms an image sent directly in the request body and returns the
  // result as binary — no bucket involved on either end. This is the flow
  // for callers who just want to hand over an image and get one back,
  // without standing up S3-compatible storage first (issue #8).
  //
  // Requires the API key, unlike the public /t/ delivery route: that one is
  // public only because <img src> can't send an Authorization header, which
  // doesn't apply to an API call that burns CPU and Rembg time per request.
  //
  // Usage: POST /transform/w_400,h_300,f_webp  (multipart, field "file")
  fastify.post("/transform/:transforms", async (request, reply) => {
    const { transforms } = request.params as { transforms: string };

    // Reject oversized uploads before reading a single byte of the body,
    // when the client announced the size up front.
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadSizeBytes) {
      return reply.status(413).send({
        error: `Upload too large. The limit is ${maxUploadSizeMb} MB (MAX_UPLOAD_SIZE_MB).`,
      });
    }

    if (!request.isMultipart()) {
      return reply.status(415).send({
        error:
          "Expected multipart/form-data with the image in a field named 'file'. " +
          "Example: curl -F 'file=@photo.jpg' ...",
      });
    }

    let input: Buffer | undefined;
    let watermarkBuffer: Buffer | undefined;

    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") continue;

        if (part.fieldname === "file") {
          input = await part.toBuffer();
        } else if (part.fieldname === "watermark") {
          // wm_ names a key in the bucket, which direct uploads don't have,
          // so the watermark travels as a second file field instead.
          watermarkBuffer = await part.toBuffer();
        } else {
          // Drain anything unexpected: leaving a part unconsumed stalls the
          // iterator on the next one.
          await part.toBuffer();
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.status(413).send({
          error: `Upload too large. The limit is ${maxUploadSizeMb} MB (MAX_UPLOAD_SIZE_MB).`,
        });
      }
      if (code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT") {
        return reply.status(400).send({ error: "Too many parts in the request" });
      }
      throw err;
    }

    if (!input || input.length === 0) {
      return reply.status(400).send({
        error: "Missing the image. Send it as a multipart field named 'file'.",
      });
    }

    const parsedTransform = parseTransformString(transforms);

    try {
      const { buffer, contentType } = await processImage(input, parsedTransform, {
        watermark: watermarkBuffer,
        // No passthrough here: echoing the caller's own bytes back with a
        // 200 would hide a corrupt or unsupported file instead of reporting it.
        onUnsupported: "error",
        log: fastify.log,
      });
      return reply.type(contentType).send(buffer);
    } catch (err) {
      if (err instanceof UnsupportedImageError) {
        return reply.status(400).send({
          error:
            "The uploaded file could not be processed as an image. It may be " +
            "corrupt, or in a format Fottly can't transform (animated GIFs, PDFs " +
            "and audio are only supported through the bucket-backed /t/ route).",
        });
      }
      if (err instanceof BackgroundRemovalError) {
        fastify.log.error(err);
        return reply.status(502).send({ error: err.message });
      }
      throw err;
    }
  });

  // Uploads a file as a raw binary body. The Content-Type header is stored
  // as-is; if a file with the same name already exists, its derived cache is
  // cleared so stale transforms of the old content aren't served afterwards.
  fastify.post("/files/*", async (request, reply) => {
    const filename = (request.params as Record<string, string>)["*"];
    if (!filename) {
      return reply.status(400).send({ error: "Missing filename" });
    }

    if (!isStorageConfigured()) {
      return reply.status(503).send({ error: STORAGE_REQUIRED_MESSAGE });
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

    if (!isStorageConfigured()) {
      return reply.status(503).send({ error: STORAGE_REQUIRED_MESSAGE });
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

    if (!isStorageConfigured()) {
      return reply.status(503).send({ error: STORAGE_REQUIRED_MESSAGE });
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

  return fastify;
}
