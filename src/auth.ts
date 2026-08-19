import type { FastifyReply, FastifyRequest } from "fastify";

// Simple API key authentication via the Authorization header.
// No user database: a single valid key set via environment variable.
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  throw new Error("Missing API_KEY environment variable");
}

const PUBLIC_PATHS = new Set(["/", "/health"]);
// Image delivery (/t/...) is public on purpose: it's served from
// <img src="..."> on real web pages, and browsers cannot send
// Authorization headers on an <img> tag. This is the same model used by
// any real image CDN (Cloudinary included): delivery is public, only
// management (/files/...: delete, rename) requires a key.
const PUBLIC_PREFIXES = ["/t/"];

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const path = request.url.split("?")[0];
  if (PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader) {
    reply.status(401).send({
      error: "Missing Authorization header. Expected format: 'Authorization: Bearer <api_key>'",
    });
    return;
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token || token !== API_KEY) {
    reply.status(401).send({ error: "Invalid API key" });
    return;
  }
}
