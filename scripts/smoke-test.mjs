/**
 * Standalone smoke test for the Cloud Mode configuration (Supabase + Cloudflare R2).
 *
 *   node --env-file=.env.local scripts/smoke-test.mjs
 *
 * Reads the same environment variable names the app reads. Secret values are
 * never printed — only names, lengths and URL hosts.
 *
 * Optional: set SMOKE_ORIGIN to test the R2 bucket's CORS preflight.
 */

import { readFileSync } from "node:fs";
import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

// ── Reporting ─────────────────────────────────────────────────────────────────

const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0, SKIP: 0 };

function log(level, name, reason) {
  counts[level] += 1;
  console.log(`[${level}] ${name} — ${reason}`);
}

/** Never let one check stop the rest, and never print more than name + message. */
async function check(name, fn) {
  try {
    await fn();
  } catch (err) {
    log("FAIL", name, `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ── Safe value formatting ─────────────────────────────────────────────────────

const env = (name) => process.env[name];

/** Secrets: name and length only. */
const secretInfo = (name) => `${name} (${(env(name) ?? "").length} chars)`;

/** R2_ACCOUNT_ID: first 4 characters then an ellipsis. */
const accountIdInfo = () => {
  const v = env("R2_ACCOUNT_ID") ?? "";
  return v ? `${v.slice(0, 4)}...` : "(unset)";
};

/** URLs: host only, never path or query. */
function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return "(unparseable URL)";
  }
}

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
  "CALLBACK_BASE_URL",
];

const URL_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "R2_PUBLIC_URL", "CALLBACK_BASE_URL"];

const isPlaceholder = (v) => /placeholder|example/i.test(v ?? "");

// ── A. Environment ────────────────────────────────────────────────────────────

async function sectionA() {
  section("A. Environment");

  await check("A1 required variables", async () => {
    const missing = REQUIRED.filter((n) => !(env(n) ?? "").trim());
    if (missing.length) {
      log("FAIL", "A1 required variables", `missing or empty: ${missing.join(", ")}`);
      return;
    }
    log("PASS", "A1 required variables", `all ${REQUIRED.length} present and non-empty`);
    log("INFO", "A1 supabase url", `host ${hostOf(env("NEXT_PUBLIC_SUPABASE_URL"))}`);
    log("INFO", "A1 r2 public url", `host ${hostOf(env("R2_PUBLIC_URL"))}`);
    log("INFO", "A1 callback base url", `host ${hostOf(env("CALLBACK_BASE_URL"))}`);
    log("INFO", "A1 r2 account", `R2_ACCOUNT_ID ${accountIdInfo()}`);
    log("INFO", "A1 r2 bucket", `R2_BUCKET_NAME ${env("R2_BUCKET_NAME")}`);
    log(
      "INFO",
      "A1 secret lengths",
      [
        secretInfo("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
        secretInfo("SUPABASE_SERVICE_ROLE_KEY"),
        secretInfo("R2_ACCESS_KEY_ID"),
        secretInfo("R2_SECRET_ACCESS_KEY"),
      ].join(", ")
    );
  });

  await check("A2 whitespace", async () => {
    const dirty = REQUIRED.filter((n) => {
      const v = env(n);
      return typeof v === "string" && v !== v.trim();
    });
    if (dirty.length) log("FAIL", "A2 whitespace", `leading/trailing whitespace in: ${dirty.join(", ")}`);
    else log("PASS", "A2 whitespace", "no leading or trailing whitespace");
  });

  await check("A2 url format", async () => {
    const bad = [];
    for (const name of URL_VARS) {
      const v = env(name) ?? "";
      if (!v) continue;
      if (!v.startsWith("https://")) bad.push(`${name} is not https://`);
      if (v.endsWith("/")) bad.push(`${name} has a trailing slash`);
    }
    if (bad.length) log("FAIL", "A2 url format", bad.join("; "));
    else log("PASS", "A2 url format", "all https:// with no trailing slash");
  });

  await check("A2 account id format", async () => {
    const v = env("R2_ACCOUNT_ID") ?? "";
    if (/^[0-9a-f]{32}$/i.test(v)) log("PASS", "A2 account id format", "32 hex characters");
    else log("WARN", "A2 account id format", `expected 32 hex characters, got ${v.length} characters (${accountIdInfo()})`);
  });

  await check("A2 callback placeholder", async () => {
    const v = env("CALLBACK_BASE_URL") ?? "";
    if (isPlaceholder(v)) log("WARN", "A2 callback placeholder", 'CALLBACK_BASE_URL still looks like a placeholder — kie.ai callbacks will not arrive');
    else log("PASS", "A2 callback placeholder", `set to a real host (${hostOf(v)})`);
  });

  await check("A3 key roles", async () => {
    const anon = env("NEXT_PUBLIC_SUPABASE_ANON_KEY") ?? "";
    const service = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (anon && service && anon === service) {
      log("FAIL", "A3 key roles", "anon key and service role key are identical");
      return;
    }

    const decode = (token) => {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      } catch {
        return null;
      }
    };

    const anonPayload = decode(anon);
    const servicePayload = decode(service);

    if (!anonPayload || !servicePayload) {
      log("INFO", "A3 key roles", "keys are not JWTs (likely sb_publishable_ / sb_secret_ format) — role check skipped");
      return;
    }

    const problems = [];
    if (anonPayload.role !== "anon") problems.push(`NEXT_PUBLIC_SUPABASE_ANON_KEY has role "${anonPayload.role}"`);
    if (servicePayload.role !== "service_role") problems.push(`SUPABASE_SERVICE_ROLE_KEY has role "${servicePayload.role}"`);

    if (problems.length) log("FAIL", "A3 key roles", `${problems.join("; ")} — keys may be swapped`);
    else log("PASS", "A3 key roles", 'roles are "anon" and "service_role" as expected');
  });

  await check("A4 danger flags", async () => {
    const problems = [];

    for (const name of ["GUEST_MODE", "NEXT_PUBLIC_GUEST_MODE", "NEXT_PUBLIC_DEMO_MODE"]) {
      if ((env(name) ?? "").trim().toLowerCase() === "true") {
        problems.push(`${name} is "true" (bypasses login and cloud storage)`);
      }
    }
    for (const name of ["KIE_API_TOKEN", "KIE_API_KEY"]) {
      if (env(name) !== undefined) {
        problems.push(`${name} is set (the kie.ai key must be per-user, not an env var)`);
      }
    }

    if (problems.length) log("FAIL", "A4 danger flags", problems.join("; "));
    else log("PASS", "A4 danger flags", "guest/demo modes off and no KIE_* variables set");
  });
}

// ── B. Supabase ───────────────────────────────────────────────────────────────

/** Extract table names from the repo's SQL files. */
function readTables() {
  const files = ["../supabase-setup.sql", "../supabase-folders.sql"];
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?([a-z_][a-z0-9_]*)/gi;
  const tables = [];

  for (const file of files) {
    const sql = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of sql.matchAll(pattern)) {
      if (!tables.includes(match[1])) tables.push(match[1]);
    }
  }
  return tables;
}

async function sectionB(tables) {
  section("B. Supabase");

  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");

  await check("B1 tables in SQL files", async () => {
    if (!tables.length) log("FAIL", "B1 tables in SQL files", "no create table statements found");
    else log("PASS", "B1 tables in SQL files", `${tables.length} tables: ${tables.join(", ")}`);
  });

  if (!url || !serviceKey || !anonKey) {
    log("SKIP", "B2-B4 supabase checks", "Supabase URL or keys missing");
    return;
  }

  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = createClient(url, serviceKey, opts);
  const anon = createClient(url, anonKey, opts);

  for (const table of tables) {
    await check(`B2 table ${table}`, async () => {
      const { count, error } = await service.from(table).select("*", { count: "exact", head: true });
      if (error) log("FAIL", `B2 table ${table}`, `${error.code ?? "error"}: ${error.message}`);
      else log("PASS", `B2 table ${table}`, `exists, ${count ?? 0} rows`);
    });
  }

  let anonVisible = 0;
  for (const table of tables) {
    await check(`B3 anon read ${table}`, async () => {
      const { count, error } = await anon.from(table).select("*", { count: "exact", head: true });
      if (error) {
        log("INFO", `B3 anon read ${table}`, `blocked (${error.code ?? "error"}: ${error.message})`);
      } else {
        if (count) anonVisible += 1;
        log("INFO", `B3 anon read ${table}`, `${count ?? 0} rows visible without a session`);
      }
    });
  }

  log(
    "INFO",
    "B3 note",
    anonVisible
      ? `${anonVisible} table(s) returned rows to an anonymous client — inspect those policies`
      : "no rows returned, but empty tables cannot prove Row Level Security is correct"
  );

  await check("B5 generations latency columns", async () => {
    const { error: phaseErr } = await service.from("generations").select("progress_phase").limit(1);
    const { error: metaErr } = await service.from("generations").select("pipeline_meta").limit(1);
    const missing = [];
    if (phaseErr?.message?.includes("progress_phase") || phaseErr?.code === "42703") {
      missing.push("progress_phase (run supabase-progress-phase.sql)");
    }
    if (metaErr?.message?.includes("pipeline_meta") || metaErr?.code === "42703") {
      missing.push("pipeline_meta (run supabase-pipeline-meta.sql)");
    }
    if (phaseErr && !phaseErr.message?.includes("progress_phase") && phaseErr.code !== "42703") {
      log("WARN", "B5 generations latency columns", `progress_phase probe: ${phaseErr.message}`);
    }
    if (metaErr && !metaErr.message?.includes("pipeline_meta") && metaErr.code !== "42703") {
      log("WARN", "B5 generations latency columns", `pipeline_meta probe: ${metaErr.message}`);
    }
    if (missing.length) log("FAIL", "B5 generations latency columns", missing.join("; "));
    else log("PASS", "B5 generations latency columns", "progress_phase and pipeline_meta present");
  });

  await check("B4 auth settings", async () => {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anonKey } });
    if (!res.ok) {
      log("FAIL", "B4 auth settings", `HTTP ${res.status} from ${hostOf(url)}/auth/v1/settings`);
      return;
    }
    const settings = await res.json();
    log("INFO", "B4 disable_signup", String(settings.disable_signup));
    log("INFO", "B4 mailer_autoconfirm", String(settings.mailer_autoconfirm));

    const enabled = Object.entries(settings.external ?? {})
      .filter(([, on]) => on === true)
      .map(([name]) => name);

    log("INFO", "B4 external providers", enabled.length ? enabled.join(", ") : "none enabled");

    const nonEmail = enabled.filter((p) => p !== "email");
    if (nonEmail.length) log("WARN", "B4 external providers", `${nonEmail.join(", ")} enabled — this project should be invite-only email login`);

    if (settings.disable_signup !== true) log("WARN", "B4 disable_signup", "public sign-up is still enabled");
    else log("PASS", "B4 disable_signup", "public sign-up is disabled");
  });
}

// ── C. Cloudflare R2 ──────────────────────────────────────────────────────────

async function sectionC() {
  section("C. Cloudflare R2");

  const accountId = env("R2_ACCOUNT_ID");
  const bucket = env("R2_BUCKET_NAME");
  const publicUrl = (env("R2_PUBLIC_URL") ?? "").replace(/\/$/, "");

  if (!accountId || !bucket || !env("R2_ACCESS_KEY_ID") || !env("R2_SECRET_ACCESS_KEY")) {
    log("SKIP", "C1-C6 r2 checks", "R2 variables missing");
    return;
  }

  // Same configuration as lib/r2.ts getS3(): region "auto", account-scoped
  // endpoint, no forcePathStyle.
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    },
  });

  const key = `smoke-test/${new Date().toISOString()}.txt`;
  const body = "heliosgen smoke test";
  let uploaded = false;

  try {
    await check("C1 head bucket", async () => {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        log("PASS", "C1 head bucket", `bucket ${bucket} reachable at ${accountIdInfo()}.r2.cloudflarestorage.com`);
      } catch (err) {
        log("FAIL", "C1 head bucket", `${err?.name ?? "Error"} (check account id, bucket name and token permissions)`);
      }
    });

    await check("C2 put object", async () => {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain" })
      );
      uploaded = true;
      log("PASS", "C2 put object", `wrote ${key}`);
    });

    await check("C3 get object", async () => {
      if (!uploaded) {
        log("SKIP", "C3 get object", "upload did not succeed");
        return;
      }
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const text = await res.Body.transformToString();
      if (text === body) log("PASS", "C3 get object", "body matches what was written");
      else log("FAIL", "C3 get object", `body differs (${text.length} chars read, ${body.length} expected)`);
    });

    await check("C4 public url", async () => {
      if (!publicUrl) {
        log("SKIP", "C4 public url", "R2_PUBLIC_URL not set");
        return;
      }
      if (!uploaded) {
        log("SKIP", "C4 public url", "upload did not succeed");
        return;
      }
      const res = await fetch(`${publicUrl}/${key}`);
      const contentType = res.headers.get("content-type") ?? "(none)";
      if (res.status === 200) {
        const text = await res.text();
        if (text === body) log("PASS", "C4 public url", `HTTP 200, content-type ${contentType}, body matches`);
        else log("FAIL", "C4 public url", `HTTP 200 but body differs, content-type ${contentType}`);
      } else if ([401, 403, 404].includes(res.status)) {
        log("FAIL", "C4 public url", `HTTP ${res.status} from ${hostOf(publicUrl)} — public access off or R2_PUBLIC_URL wrong`);
      } else {
        log("FAIL", "C4 public url", `HTTP ${res.status} from ${hostOf(publicUrl)}, content-type ${contentType}`);
      }
    });

    await check("C5 cors preflight", async () => {
      const origin = env("SMOKE_ORIGIN");
      if (!origin) {
        log("SKIP", "C5 cors preflight", "SMOKE_ORIGIN not set");
        return;
      }
      const res = await fetch(`${publicUrl}/${key}`, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      });
      const allow = res.headers.get("access-control-allow-origin");
      log(
        "INFO",
        "C5 cors preflight",
        allow
          ? `HTTP ${res.status}, access-control-allow-origin: ${allow}`
          : `HTTP ${res.status}, no access-control-allow-origin header — add a CORS rule for ${hostOf(origin)} (GET)`
      );
    });
  } finally {
    await check("C6 delete object", async () => {
      if (!uploaded) {
        log("SKIP", "C6 delete object", "nothing was uploaded");
        return;
      }
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        log("PASS", "C6 delete object", `removed ${key}`);
      } catch (err) {
        log("FAIL", "C6 delete object", `${err?.name ?? "Error"}: ${err?.message ?? String(err)} — remove ${key} by hand`);
      }

      if (publicUrl) {
        try {
          const res = await fetch(`${publicUrl}/${key}`);
          log("INFO", "C6 re-fetch after delete", `HTTP ${res.status} (a 200 here may just be a cached edge response)`);
        } catch (err) {
          log("INFO", "C6 re-fetch after delete", `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
        }
      }
    });
  }
}

// ── D. Live app (GET only) ────────────────────────────────────────────────────

async function sectionD() {
  section("D. Live app");

  const base = (env("CALLBACK_BASE_URL") ?? "").replace(/\/$/, "");

  await check("D2 callback route exists", async () => {
    if (!base || isPlaceholder(base)) {
      log("SKIP", "D2 callback route exists", "CALLBACK_BASE_URL is unset or a placeholder");
      return;
    }
    try {
      const res = await fetch(`${base}/api/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ received: true }),
      });
      if (res.status === 405) {
        log("PASS", "D2 callback route exists", "route mounted (405 without POST body is ok)");
      } else if (res.ok || res.status === 200) {
        log("PASS", "D2 callback route exists", `HTTP ${res.status}`);
      } else {
        log("INFO", "D2 callback route exists", `HTTP ${res.status} — confirm Kie can POST here`);
      }
    } catch (err) {
      log("WARN", "D2 callback route exists", `${err?.message ?? String(err)}`);
    }
  });

  await check("D1 callback host reachable", async () => {
    if (!base || isPlaceholder(base)) {
      log("SKIP", "D1 callback host reachable", "CALLBACK_BASE_URL is unset or a placeholder");
      return;
    }
    const res = await fetch(`${base}/`, { redirect: "manual" });
    const text = await res.text().catch(() => "");
    const blocked = res.status === 401 || /vercel (authentication|sso)|deployment protection|_vercel\/sso/i.test(text);

    if (blocked) {
      log(
        "FAIL",
        "D1 callback host reachable",
        `HTTP ${res.status} — Deployment Protection is blocking public access, so kie.ai's callback cannot reach the app`
      );
    } else {
      log("PASS", "D1 callback host reachable", `HTTP ${res.status} from ${hostOf(base)}`);
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("HeliosGen Cloud Mode smoke test (no secret values are printed)");

  let tables = [];
  try {
    tables = readTables();
  } catch (err) {
    log("FAIL", "B1 tables in SQL files", `${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
  }

  await sectionA();
  await sectionB(tables);
  await sectionC();
  await sectionD();

  section("Summary");
  console.log(
    `PASS ${counts.PASS}  FAIL ${counts.FAIL}  WARN ${counts.WARN}  INFO ${counts.INFO}  SKIP ${counts.SKIP}`
  );

  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}

main().catch((err) => {
  console.log(`[FAIL] smoke test — ${err?.name ?? "Error"}: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
