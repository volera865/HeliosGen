/**
 * Apply / verify R2 CORS for browser direct uploads (presigned PUT).
 *
 *   node --env-file=.env scripts/apply-r2-cors.mjs
 *
 * Uses scripts/r2-cors.json (same policy as docs/HANDOVER.md).
 * R2 Object Read & Write tokens often cannot change bucket CORS — if Access
 * Denied, paste r2-cors.json in Cloudflare → R2 → bucket → Settings → CORS.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  S3Client,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
} from "@aws-sdk/client-s3";

const env = (n) => process.env[n];
const required = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
];
for (const name of required) {
  if (!env(name)) {
    console.error(`[FAIL] missing ${name}`);
    process.exit(1);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(__dirname, "r2-cors.json"), "utf8"));

const bucket = env("R2_BUCKET_NAME");
const accountId = env("R2_ACCOUNT_ID");
const productionOrigin = "https://higgsfield-n7pq.vercel.app";

const CORSRules = policy.map((rule) => ({
  AllowedOrigins: rule.AllowedOrigins,
  AllowedMethods: rule.AllowedMethods,
  AllowedHeaders: rule.AllowedHeaders,
  ExposeHeaders: rule.ExposeHeaders,
  MaxAgeSeconds: rule.MaxAgeSeconds,
}));

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

function printDashboardFallback() {
  console.log(`
── Dashboard fallback (S3 token lacks Admin Write) ─────────────────
1. Cloudflare → R2 → bucket "${bucket}" → Settings
2. CORS Policy → Add / Edit → paste contents of scripts/r2-cors.json
3. Save, wait a few seconds, hard-refresh https://higgsfield-n7pq.vercel.app/gallery
4. Upload an image; Network PUT to *.r2.cloudflarestorage.com should be 200
────────────────────────────────────────────────────────────────────`);
}

try {
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules },
    }),
  );
  pass("put-cors", `applied to bucket ${bucket}`);
} catch (err) {
  fail("put-cors", err?.message ?? String(err));
  printDashboardFallback();
  process.exit(1);
}

try {
  const got = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
  const rules = got.CORSRules ?? [];
  const origins = rules.flatMap((r) => r.AllowedOrigins ?? []);
  const methods = rules.flatMap((r) => r.AllowedMethods ?? []);
  if (!origins.includes(productionOrigin)) {
    fail("get-cors", `missing origin ${productionOrigin}`);
  } else if (!methods.includes("PUT")) {
    fail("get-cors", "PUT not in AllowedMethods");
  } else {
    pass(
      "get-cors",
      `origins=${origins.join(",")} methods=${[...new Set(methods)].join(",")}`,
    );
  }

  const preflightUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/uploads/cors-preflight-probe`;
  const opt = await fetch(preflightUrl, {
    method: "OPTIONS",
    headers: {
      Origin: productionOrigin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const allowOrigin = opt.headers.get("access-control-allow-origin");
  const allowMethods = opt.headers.get("access-control-allow-methods") ?? "";
  if (opt.ok && allowOrigin === productionOrigin && /PUT/i.test(allowMethods)) {
    pass(
      "preflight",
      `HTTP ${opt.status} allow-origin=${allowOrigin} allow-methods=${allowMethods}`,
    );
  } else {
    fail(
      "preflight",
      `HTTP ${opt.status} allow-origin=${allowOrigin ?? "(none)"} allow-methods=${allowMethods || "(none)"} — if get-cors passed, wait ~30s and retry browser upload`,
    );
  }
} catch (err) {
  fail("verify", err?.message ?? String(err));
}

console.log(
  failed
    ? "\nCORS verify had failures."
    : "\nCORS applied. Hard-refresh Production and upload an image again.",
);
process.exit(failed ? 1 : 0);
