/**
 * Confirm Seedance 2.0 Fast still works while the Google channel is down,
 * using the same reference image and 9:16 / 720p settings as the failed job.
 *
 * Usage: node scripts/diag-seedance-probe.mjs
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
const PROMPT = fs.readFileSync("scripts/diag-omni-prompt.txt", "utf8").trim();

const key = kieKey();
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const input = {
  prompt: PROMPT,
  aspect_ratio: "9:16",
  duration: 8,
  resolution: "720p",
  generate_audio: false,
  reference_image_urls: [IMG_A, IMG_B],
  web_search: false,
};

const res = await fetch(CREATE, {
  method: "POST", headers: auth,
  body: JSON.stringify({ model: "bytedance/seedance-2-fast", input }),
});
const body = await res.json().catch(() => ({}));
console.log(`[submit] seedance-2-fast http=${res.status} code=${body.code} msg=${body.msg} task=${body?.data?.taskId ?? "-"}`);
if (body.code !== 200) process.exit(1);

const taskId = body.data.taskId;
const t0 = Date.now();

for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await fetch(`${RECORD}?taskId=${encodeURIComponent(taskId)}`, { headers: auth });
  const d = (await r.json().catch(() => ({}))).data ?? {};
  const state = String(d.state ?? d.status ?? "").toLowerCase();
  const secs = Math.round((Date.now() - t0) / 1000);
  if (["fail", "failed", "error"].includes(state)) {
    console.log(`[${secs}s] FAIL code=${d.failCode} credits=${d.creditsConsumed} "${d.failMsg}"`);
    process.exit(1);
  }
  if (state === "success") {
    console.log(`[${secs}s] SUCCESS credits=${d.creditsConsumed}`);
    console.log("resultJson:", JSON.stringify(d.resultJson));
    process.exit(0);
  }
  console.log(`[${secs}s] ... ${state}`);
}
console.log("still running after 5 min — payload accepted, generation in progress");
