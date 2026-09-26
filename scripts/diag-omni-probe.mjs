/**
 * Isolate why gemini-omni-video returns an opaque kie 500 for a given job.
 *
 * Failed kie jobs consume 0 credits, so a probe that fails is free. Probes that
 * get past the ~25s rejection gate are cancelled immediately to limit spend.
 *
 * Usage: node scripts/diag-omni-probe.mjs
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

const IMG_A = "https://tempfile.redpandaai.co/kieai/11993531/heliosgen/8000cf97-81a6-4e36-89ca-d84dbcaa68ff.png";
const IMG_B = "https://tempfile.redpandaai.co/kieai/11993531/heliosgen/586602c5-3f5b-4a8c-8e23-1c8715662b41.png";

const FULL = fs.readFileSync("scripts/diag-omni-prompt.txt", "utf8").trim();
const NO_NEG = FULL.slice(0, FULL.indexOf("STRICT NEGATIVE PROMPT")).trim();
const SHORT = "A woman behind a wooden table in a warehouse hands a small jar to another woman. Fixed security-camera view.";

const PROBES = [
  { id: "P1 baseline: full prompt + 2 images", prompt: FULL,   images: [IMG_A, IMG_B] },
  { id: "P2 full prompt minus negative block", prompt: NO_NEG, images: [IMG_A, IMG_B] },
  { id: "P3 short prompt + 2 images",          prompt: SHORT,  images: [IMG_A, IMG_B] },
  { id: "P4 full prompt + 0 images",           prompt: FULL,   images: [] },
  { id: "P5 short prompt + 0 images",          prompt: SHORT,  images: [] },
];

const key = kieKey();
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function submit(p) {
  const input = { prompt: p.prompt, duration: "4", aspect_ratio: "9:16", resolution: "720p" };
  if (p.images.length) input.image_urls = p.images;
  const res = await fetch(CREATE, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ model: "gemini-omni-video", input }),
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
for (const p of PROBES) {
  const r = await submit(p);
  started.push({ ...p, ...r, t0: Date.now() });
  console.log(`[submit] ${p.id} -> http=${r.http} code=${r.code} task=${r.taskId ?? "-"} ${r.msg ?? ""}`);
  if (r.code !== 200) console.log(`   rejected at submit: ${JSON.stringify(r)}`);
}

const live = started.filter((s) => s.taskId);
const settled = new Map();

for (let i = 0; i < 40 && settled.size < live.length; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  for (const s of live) {
    if (settled.has(s.taskId)) continue;
    const d = await record(s.taskId);
    const state = String(d.state ?? d.status ?? "").toLowerCase();
    const secs = Math.round((Date.now() - s.t0) / 1000);
    if (state === "fail" || state === "failed" || state === "error") {
      settled.set(s.taskId, { s, state, d, secs });
      console.log(`[${secs}s] ${s.id} => FAIL code=${d.failCode} credits=${d.creditsConsumed} msg="${d.failMsg}"`);
    } else if (state === "success") {
      settled.set(s.taskId, { s, state, d, secs });
      console.log(`[${secs}s] ${s.id} => SUCCESS credits=${d.creditsConsumed}`);
    } else if (secs > 60) {
      // Past the rejection gate: the payload itself is accepted.
      settled.set(s.taskId, { s, state: `accepted(${state})`, d, secs });
      console.log(`[${secs}s] ${s.id} => PASSED GATE (state=${state}) — payload accepted`);
    } else {
      console.log(`[${secs}s] ${s.id} ... ${state}`);
    }
  }
}

console.log("\n===== SUMMARY =====");
for (const s of started) {
  const r = settled.get(s.taskId);
  const verdict = s.code !== 200 ? `SUBMIT-REJECT (${s.msg})` : r ? r.state : "unresolved";
  console.log(`${s.id.padEnd(40)} promptChars=${String(s.prompt.length).padEnd(6)} imgs=${s.images.length}  => ${verdict}`);
}
