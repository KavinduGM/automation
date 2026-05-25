import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { env, logger } from "@ca/shared";

// Optional Backblaze B2 (S3-compatible) uploader, used by the nightly backup
// script and for offloading large media files when local disk gets tight.

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  const e = env();
  if (!e.B2_KEY_ID || !e.B2_APPLICATION_KEY || !e.B2_ENDPOINT) {
    throw new Error("B2_* env vars not set");
  }
  _client = new S3Client({
    region: "auto",
    endpoint: e.B2_ENDPOINT,
    credentials: { accessKeyId: e.B2_KEY_ID, secretAccessKey: e.B2_APPLICATION_KEY },
    forcePathStyle: true,
  });
  return _client;
}

export async function uploadToB2(localPath: string, key?: string): Promise<{ key: string; bytes: number }> {
  const bucket = env().B2_BUCKET;
  if (!bucket) throw new Error("B2_BUCKET not set");
  const objectKey = key ?? basename(localPath);
  const { size } = await stat(localPath);
  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: createReadStream(localPath),
      ContentLength: size,
    }),
  );
  logger.info({ key: objectKey, bytes: size }, "b2.uploaded");
  return { key: objectKey, bytes: size };
}
