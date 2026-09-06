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
//
// The client is built lazily, on first use, instead of at import time.
// That's deliberate: POST /transform/:transforms takes the image in the
// request body and never touches the bucket, so a self-hoster who only
// wants that endpoint can run Fottly with no S3 configuration at all.
// Configuring it at import time would make the process fail to boot
// without S3_BUCKET, which would defeat the point.

// Thrown when an S3-backed route is used on an instance that has no
// storage configured. Routes map it to 503.
export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      "S3 storage is not configured on this instance. Set S3_BUCKET (and the " +
        "matching credentials) to use the bucket-backed routes, or use " +
        "POST /transform/:transforms to send the image directly in the request.",
    );
    this.name = "StorageNotConfiguredError";
  }
}

interface Storage {
  client: S3Client;
  bucket: string;
}

let cached: Storage | undefined;

// Whether this instance has a bucket configured. Routes use it to answer
// with a clear 503 instead of failing deeper in the AWS SDK.
export function isStorageConfigured(): boolean {
  return Boolean(process.env.S3_BUCKET);
}

function storage(): Storage {
  if (cached) return cached;

  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new StorageNotConfiguredError();
  }

  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  cached = { client, bucket };
  return cached;
}

async function streamToBuffer(stream: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function objectExists(key: string): Promise<boolean> {
  const { client, bucket } = storage();
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
  const { client, bucket } = storage();
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
  const { client, bucket } = storage();
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
  const { client, bucket } = storage();
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
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// Copies an object within the same bucket (used for rename/move: copy to
// the destination and then delete the source).
export async function copyObject(sourceKey: string, destKey: string): Promise<void> {
  const { client, bucket } = storage();
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
  const { client, bucket } = storage();
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
