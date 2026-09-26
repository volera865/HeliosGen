/**
 * Gate-test alternative kie video models to prove the account/key is healthy and
 * the gemini-omni-video 500 is model-specific.
 *
 * Uses a short prompt and the shortest duration to keep credit spend minimal.
 * Usage: node scripts/diag-omni-models.mjs
 */
import fs from "node:fs";

const CREATE = "https://api.kie.ai/api/v1/jobs/createTask";
const RECORD = "https://api.kie.ai/api/v1/jobs/recordInfo";

function kieKey() {
  const db = JSON.parse(fs.readFileSync("data/guest-db.json", "utf8"));
  const walk = (o, d = 0) => {
    if (d > 6 || !o || typeof o !== "object") return null;
    for (const [k, v] of Object.entries(o)) {
      if (/kie.*(token|key)/i.test(k) && typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "object") { const r = walk(v, d + 1); if (r) return r; }
    }
    return null;
  };
  const key = walk(db);
  if (!key) throw new Error("no kie key in data/guest-db.json");
  return key;
}

const SHORT = "A woman behind a wooden table in a warehouse hands a small jar to another woman. Fixed security-camera view.";

const CANDIDATES = [
  { id: "gemini-omni-video (control)", model: "gemini-omni-video", input: { prompt: SHORT, duration: "4", aspect_ratio: "9:16", resolution: "720p" } },
  { id: "veo3_fast",                   model: "veo3_fast",         input: { prompt: SHORT, aspect_ratio: "9:16", resolution: "720p", generationType: "TEXT_2_VIDEO", enableTranslation: true } },
  { id: "kling-3.0/video",             model: "kling-3.0/video",   input: { prompt: SHORT, aspect_ratio: "9:16", duration: 5, mode: "pro" } },
];

const key = kieKey();
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function submit(c) {
  const res = await fetch(CREATE, {
    method: "POST", headers: auth,
    body: JSON.stringify({ model: c.model, input: c.input }),
  });
  const body = await res.json().catch(() => ({}));
  return { http: res.status, code: body.code, msg: body.msg, taskId: body?.data?.taskId };
}

async function record(taskId) {
  const res = await fetch(`${RECORD}?taskId=${encodeURIComponent(taskId)}`, { headers: auth });
  const body = await res.json().catch(() => ({}));
  return body.data ?? {};
}

const started = [];
for (const c of CANDIDATES) {
  const r = await submit(c);
  started.push({ ...c, ...r, t0: Date.now() });
  console.log(`[submit] ${c.id} -> http=${r.http} code=${r.code} task=${r.taskId ?? "-"} ${r.msg ?? ""}`);
}

const live = started.filter((s) => s.taskId);
const settled = new Map();

for (let i = 0; i < 24 && settled.size < live.length; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  for (const s of live) {
    if (settled.has(s.taskId)) continue;
    const d = await record(s.taskId);
    const state = String(d.state ?? d.status ?? "").toLowerCase();
    const secs = Math.round((Date.now() - s.t0) / 1000);
    if (["fail", "failed", "error"].includes(state)) {
      settled.set(s.taskId, `FAIL code=${d.failCode} credits=${d.creditsConsumed} "${d.failMsg}"`);
      console.log(`[${secs}s] ${s.id} => FAIL code=${d.failCode} credits=${d.creditsConsumed} "${d.failMsg}"`);
    } else if (state === "success") {
      settled.set(s.taskId, `SUCCESS credits=${d.creditsConsumed}`);
      console.log(`[${secs}s] ${s.id} => SUCCESS credits=${d.creditsConsumed}`);
    } else if (secs > 75) {
      settled.set(s.taskId, `PASSED GATE (state=${state}) — model is healthy`);
      console.log(`[${secs}s] ${s.id} => PASSED GATE (state=${state})`);
    } else {
      console.log(`[${secs}s] ${s.id} ... ${state}`);
    }
  }
}

console.log("\n===== SUMMARY =====");
for (const s of started) {
  console.log(`${s.id.padEnd(30)} => ${s.code !== 200 ? `SUBMIT-REJECT (${s.msg})` : settled.get(s.taskId) ?? "unresolved"}`);
}
