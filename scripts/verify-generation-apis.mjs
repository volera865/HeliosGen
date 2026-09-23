/**
 * Lightweight checks for generation API routes (no Kie submit).
 *
 *   node --env-file=.env.local scripts/verify-generation-apis.mjs
 *
 * Optional:
 *   SMOKE_ORIGIN=https://your-app.vercel.app  (defaults to CALLBACK_BASE_URL)
 *   SMOKE_SESSION_COOKIE="..."                — run authenticated diagnostic probe
 *   SMOKE_TASK_ID=talk-... or Kie taskId      — with cookie, GET job-diagnostic
 */

const env = (name) => process.env[name]?.trim() ?? "";

const counts = { PASS: 0, FAIL: 0, SKIP: 0 };

function log(level, name, reason) {
  counts[level] += 1;
  console.log(`[${level}] ${name} — ${reason}`);
}

async function check(name, fn) {
  try {
    await fn();
  } catch (e) {
    log("FAIL", name, e?.message ?? String(e));
  }
}

function origin() {
  const base = (env("SMOKE_ORIGIN") || env("CALLBACK_BASE_URL")).replace(/\/$/, "");
  return base || null;
}

async function main() {
  console.log("HeliosGen generation API verification");

  const base = origin();
  if (!base) {
    log("SKIP", "origin", "Set SMOKE_ORIGIN or CALLBACK_BASE_URL");
    process.exitCode = 0;
    return;
  }

  await check("job-status missing taskId", async () => {
    const res = await fetch(`${base}/api/job-status`);
    if (res.status === 400) log("PASS", "job-status missing taskId", "HTTP 400");
    else log("FAIL", "job-status missing taskId", `expected 400, got ${res.status}`);
  });

  await check("job-status unauthenticated", async () => {
    const res = await fetch(`${base}/api/job-status?taskId=test-not-a-real-id`);
    if (res.status === 401) log("PASS", "job-status unauthenticated", "HTTP 401");
    else if (res.status === 404) log("PASS", "job-status unauthenticated", "HTTP 404 (session present)");
    else log("FAIL", "job-status unauthenticated", `expected 401/404, got ${res.status}`);
  });

  await check("job-diagnostic unauthenticated", async () => {
    const res = await fetch(`${base}/api/job-diagnostic?taskId=test`);
    if (res.status === 401) log("PASS", "job-diagnostic unauthenticated", "HTTP 401");
    else log("FAIL", "job-diagnostic unauthenticated", `expected 401, got ${res.status}`);
  });

  await check("cancel-job unauthenticated", async () => {
    const res = await fetch(`${base}/api/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    // cancel-job is separate
    const cancel = await fetch(`${base}/api/cancel-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (cancel.status === 401 || cancel.status === 400) {
      log("PASS", "cancel-job unauthenticated", `HTTP ${cancel.status}`);
    } else {
      log("FAIL", "cancel-job unauthenticated", `expected 401/400, got ${cancel.status}`);
    }
    void res;
  });

  await check("callback minimal payload", async () => {
    const res = await fetch(`${base}/api/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ received: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.received === true) {
      log("PASS", "callback minimal payload", "HTTP 200 { received: true }");
    } else {
      log("FAIL", "callback minimal payload", `HTTP ${res.status} ${JSON.stringify(body)}`);
    }
  });

  const cookie = env("SMOKE_SESSION_COOKIE");
  const taskId = env("SMOKE_TASK_ID");
  if (cookie && taskId) {
    await check("job-diagnostic live task", async () => {
      const res = await fetch(`${base}/api/job-diagnostic?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Cookie: cookie },
      });
      if (!res.ok) {
        log("FAIL", "job-diagnostic live task", `HTTP ${res.status}`);
        return;
      }
      const body = await res.json();
      if (body.helios && typeof body.helios.status === "string") {
        log("PASS", "job-diagnostic live task", `status=${body.helios.status} kie=${body.kie?.state ?? "n/a"}`);
      } else {
        log("FAIL", "job-diagnostic live task", "unexpected JSON shape");
      }
    });
  } else {
    log("SKIP", "job-diagnostic live task", "Set SMOKE_SESSION_COOKIE + SMOKE_TASK_ID for live probe");
  }

  console.log(`\nSummary: PASS ${counts.PASS}  FAIL ${counts.FAIL}  SKIP ${counts.SKIP}`);
  process.exitCode = counts.FAIL > 0 ? 1 : 0;
}

main();
