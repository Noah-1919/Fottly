import type { FastifyReply, FastifyRequest } from "fastify";

// Simple API key authentication via the Authorization header.
// No user database: valid keys come from environment variables.
//
// - API_KEY: the original single-key mode. Still required — kept as the
//   admin/fallback key and for backward compatibility with self-hosted
//   deployments that only ever had one key.
// - API_KEYS: optional comma-separated list of additional keys, one per
//   Fottly Cloud customer sharing this instance. To onboard a new
//   customer, generate a key (e.g. `openssl rand -hex 32`), add it to
//   this list, and redeploy with `docker compose up -d app` (not
//   `restart` — that does not pick up a changed .env).
//
// All keys currently share the same S3 bucket, so filenames can collide
// between customers. Fine with a single Cloud customer; needs a
// per-customer key prefix before onboarding a second one.
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  throw new Error("Missing API_KEY environment variable");
}

const EXTRA_KEYS = (process.env.API_KEYS ?? "")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const VALID_KEYS = new Set([API_KEY, ...EXTRA_KEYS]);

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
  if (scheme !== "Bearer" || !token || !VALID_KEYS.has(token)) {
    reply.status(401).send({ error: "Invalid API key" });
    return;
  }
}
