import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  NotFound,
} from "@aws-sdk/client-s3";

// S3-compatible storage (AWS S3 / Cloudflare R2 / MinIO).
// All configuration comes from environment variables so you can point at
// a different provider without touching code.
const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION ?? "us-east-1";
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
const forcePathStyle = process.env.S3_FORCE_PATH_STYLE !== "false";

if (!bucket) {
  throw new Error("Missing S3_BUCKET environment variable");
}

export const BUCKET = bucket;

const client = new S3Client({
  endpoint,
  region,
  forcePathStyle,
  credentials:
    accessKeyId && secretAccessKey
      ? { accessKeyId, secretAccessKey }
      : undefined,
});

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err instanceof NotFound) return false;
    // Some S3-compatible backends return a generic 404 instead of NotFound.
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

export async function getObject(key: string): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return streamToBuffer(response.Body);
}

// Same as getObject, but also returns the Content-Type stored in S3.
// Used when serving from cache, where the real type (transformed image,
// passthrough of a PDF/SVG/audio file...) can't be inferred from the URL alone.
export async function getObjectWithContentType(
  key: string,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const buffer = await streamToBuffer(response.Body);
  return { buffer, contentType: response.ContentType };
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType?: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// Copies an object within the same bucket (used for rename/move: copy to
// the destination and then delete the source).
export async function copyObject(sourceKey: string, destKey: string): Promise<void> {
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(sourceKey)}`,
      Key: destKey,
    }),
  );
}

// Lists all keys under a prefix (paginating as needed).
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of response.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}
