/**
 * Smoke: direct-to-R2 presigned PUT for files >4 MB (Vercel body bypass).
 *
 *   node --env-file=.env.local scripts/smoke-direct-upload.mjs
 *
 * Does not hit Next.js auth routes — exercises the same S3 presign + browser PUT
 * pattern as lib/r2.ts + lib/uploadAssetClient.ts. Cleans up the test object.
 */

import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const env = (n) => process.env[n];
const required = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
];

for (const name of required) {
  if (!env(name)) {
    console.error(`[FAIL] missing ${name}`);
    process.exit(1);
  }
}

const accountId = env("R2_ACCOUNT_ID");
const bucket = env("R2_BUCKET_NAME");
const publicBase = env("R2_PUBLIC_URL").replace(/\/$/, "");
const key = `uploads/smoke-direct-${randomUUID()}.bin`;
const contentType = "application/octet-stream";
/** Just over Vercel’s ~4.5 MB body limit. */
const BYTE_SIZE = 5 * 1024 * 1024;
const body = Buffer.alloc(BYTE_SIZE, 0xab);

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  },
});

let failed = false;
function pass(name, detail) {
  console.log(`[PASS] ${name} — ${detail}`);
}
function fail(name, detail) {
  failed = true;
  console.log(`[FAIL] ${name} — ${detail}`);
}

try {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
  pass("presign", `signed PUT for ${key.slice(0, 24)}… (${BYTE_SIZE} bytes)`);

  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body,
  });
  if (!putRes.ok) {
    fail("put", `HTTP ${putRes.status} (if browser CORS later: set bucket CORS for PUT)`);
  } else {
    pass("put", `HTTP ${putRes.status}`);
  }

  const cdnUrl = `${publicBase}/${key}`;
  const headRes = await fetch(cdnUrl, { method: "HEAD" });
  if (!headRes.ok) {
    fail("cdn", `HTTP ${headRes.status} from public URL host`);
  } else {
    const len = headRes.headers.get("content-length");
    pass("cdn", `HTTP ${headRes.status}${len ? ` content-length=${len}` : ""}`);
  }

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  pass("cleanup", "deleted smoke object");
} catch (err) {
  fail("exception", err?.message ?? String(err));
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch {
    /* ignore */
  }
}

console.log(
  failed
    ? "\nDirect upload smoke FAILED. Fix R2 credentials/public access before Production."
    : "\nDirect upload smoke OK (>4 MB via presigned PUT).",
);
process.exit(failed ? 1 : 0);
