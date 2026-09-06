import { test, before } from "node:test";
import assert from "node:assert";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import type { FastifyInstance } from "fastify";

// These tests exercise POST /transform/:transforms, the direct-upload flow.
// They deliberately run with NO S3 configuration: the whole point of the
// endpoint is that it works without a bucket, so if importing the app ever
// starts requiring S3_BUCKET again, this file fails to even load.
process.env.NODE_ENV = "test";
process.env.API_KEY = "test-key";
process.env.MAX_UPLOAD_SIZE_MB = "1";
delete process.env.S3_BUCKET;

const AUTH = { authorization: "Bearer test-key" };
const MAX_BYTES = 1024 * 1024;

// src/auth.ts and src/app.ts read configuration at import/build time, so the
// environment above has to be in place before the module is pulled in.
let buildServer: () => Promise<FastifyInstance>;
let app: FastifyInstance;

before(async () => {
  ({ buildServer } = await import("./app.js"));
  app = await buildServer();
  await app.ready();
});

interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

// Builds a multipart/form-data body by hand rather than pulling in a
// form-data dependency just for the tests.
function multipart(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = `----FottlyTest${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];

  for (const part of parts) {
    let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) headers += `; filename="${part.filename}"`;
    headers += `\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`;
    chunks.push(Buffer.from(headers), part.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// POSTs over a real socket without a Content-Length header, so Node falls
// back to Transfer-Encoding: chunked.
function postChunked(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ port, path, method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function pngFixture(width = 120, height = 90): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .png()
    .toBuffer();
}

test("transforms an uploaded image and returns it as binary", async () => {
  const { body, contentType } = multipart([
    { name: "file", filename: "photo.png", contentType: "image/png", data: await pngFixture() },
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/transform/w_40,h_30,f_webp",
    headers: { ...AUTH, "content-type": contentType },
    payload: body,
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers["content-type"], "image/webp");

  // The response body is the actual transformed image, not a JSON pointer
  // to one: decode it and check the transforms really were applied.
  const result = await sharp(response.rawPayload).metadata();
  assert.strictEqual(result.format, "webp");
  assert.strictEqual(result.width, 40);
  assert.strictEqual(result.height, 30);
});

test("applies a watermark sent as a second file field", async () => {
  const { body, contentType } = multipart([
    { name: "file", filename: "photo.png", contentType: "image/png", data: await pngFixture(200, 200) },
    { name: "watermark", filename: "logo.png", contentType: "image/png", data: await pngFixture(50, 50) },
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/transform/w_100,h_100,f_png,wg_southeast",
    headers: { ...AUTH, "content-type": contentType },
    payload: body,
  });

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.headers["content-type"], "image/png");
  const result = await sharp(response.rawPayload).metadata();
  assert.strictEqual(result.width, 100);
  assert.strictEqual(result.height, 100);
});

test("rejects an upload whose declared size is over the limit", async () => {
  const { body, contentType } = multipart([
    {
      name: "file",
      filename: "huge.png",
      contentType: "image/png",
      data: Buffer.alloc(MAX_BYTES + 1024, 1),
    },
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/transform/w_40",
    headers: { ...AUTH, "content-type": contentType },
    payload: body,
  });

  assert.strictEqual(response.statusCode, 413);
  assert.match(response.json().error, /too large/i);
});

test("rejects an oversized chunked upload that declares no size up front", async () => {
  // The busboy fileSize cap, not the Content-Length pre-check, is the real
  // memory guard: without it a chunked upload could grow unbounded in
  // memory before anything noticed. Reaching it needs a request with no
  // Content-Length, and fastify.inject() can't produce one — it buffers the
  // payload and sets the header itself, even when handed a stream. So this
  // one test goes over a real socket with Transfer-Encoding: chunked.
  const { body, contentType } = multipart([
    {
      name: "file",
      filename: "huge.png",
      contentType: "image/png",
      data: Buffer.alloc(MAX_BYTES + 1024, 1),
    },
  ]);

  const server = await buildServer();
  // Recorded server-side to prove the request really did arrive without a
  // Content-Length, i.e. that the pre-check was skipped and the fileSize
  // cap is what produced the 413.
  let declaredLength: string | undefined = "not recorded";
  server.addHook("onRequest", async (request) => {
    declaredLength = request.headers["content-length"];
  });
  await server.listen({ port: 0, host: "127.0.0.1" });
  const { port } = server.server.address() as AddressInfo;

  try {
    const response = await postChunked(port, "/transform/w_40", {
      ...AUTH,
      "content-type": contentType,
    }, body);

    assert.strictEqual(declaredLength, undefined);
    assert.strictEqual(response.statusCode, 413);
    assert.match(JSON.parse(response.body).error, /too large/i);
  } finally {
    await server.close();
  }
});

test("rejects a corrupt file with a 400 instead of echoing it back", async () => {
  const { body, contentType } = multipart([
    {
      name: "file",
      filename: "broken.png",
      contentType: "image/png",
      data: Buffer.from("this is definitely not a PNG"),
    },
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/transform/w_40,f_webp",
    headers: { ...AUTH, "content-type": contentType },
    payload: body,
  });

  // Not a passthrough: /t/ serves undecodable files as-is because the bucket
  // holds PDFs and audio too, but here that would just hand the caller their
  // own broken file back with a 200.
  assert.strictEqual(response.statusCode, 400);
  assert.match(response.json().error, /could not be processed/i);
});

test("rejects a request with no file field", async () => {
  const { body, contentType } = multipart([
    { name: "notthefile", filename: "x.png", contentType: "image/png", data: await pngFixture() },
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/transform/w_40",
    headers: { ...AUTH, "content-type": contentType },
    payload: body,
  });

  assert.strictEqual(response.statusCode, 400);
  assert.match(response.json().error, /missing the image/i);
});

test("rejects a non-multipart request with a 415", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/transform/w_40",
    headers: { ...AUTH, "content-type": "image/png" },
    payload: await pngFixture(),
  });

  assert.strictEqual(response.statusCode, 415);
  assert.match(response.json().error, /multipart/i);
});

test("requires the API key, unlike the public /t/ delivery route", async () => {
  const { body, contentType } = multipart([
    { name: "file", filename: "photo.png", contentType: "image/png", data: await pngFixture() },
  ]);

  const response = await app.inject({
    method: "POST",
    url: "/transform/w_40",
    headers: { "content-type": contentType },
    payload: body,
  });

  assert.strictEqual(response.statusCode, 401);
});

test("the server runs with no S3 configuration at all", async () => {
  // Direct uploads must not depend on a bucket existing (issue #8): the
  // app booted above with S3_BUCKET unset, and the S3-backed routes answer
  // with a clear 503 rather than crashing the process at startup.
  assert.strictEqual(process.env.S3_BUCKET, undefined);

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.strictEqual(health.statusCode, 200);

  const delivery = await app.inject({ method: "GET", url: "/t/w_40/photo.jpg" });
  assert.strictEqual(delivery.statusCode, 503);
  assert.match(delivery.json().error, /not configured/i);
});
