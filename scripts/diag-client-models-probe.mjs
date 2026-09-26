/**
 * Live verify every client-required model against kie.ai.
 *
 * Usage: node scripts/diag-client-models-probe.mjs
 */
import fs from "node:fs";
import path from "node:path";

const CREATE = "https://api.kie.ai/api/v1/jobs/createTask";
const RECORD = "https://api.kie.ai/api/v1/jobs/recordInfo";
const UPLOAD = "https://kieai.redpandaai.co/api/file-stream-upload";

function kieKey() {
  for (const p of [".env.local", ".env"]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^KIE_API_KEY=(.+)$/);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "");
        if (v && !v.includes("placeholder")) return v;
      }
    }
  }
  const db = JSON.parse(fs.readFileSync("data/guest-db.json", "utf8"));
  const walk = (o, d = 0) => {
    if (d > 6 || !o || typeof o !== "object") return null;
    for (const [k, v] of Object.entries(o)) {
      if (/kie.*(token|key)/i.test(k) && typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "object") {
        const r = walk(v, d + 1);
        if (r) return r;
      }
    }
    return null;
  };
  const key = walk(db);
  if (!key) throw new Error("no kie key");
  return key;
}

const key = kieKey();
const authJson = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const authBearer = { Authorization: `Bearer ${key}` };

async function uploadLocal(relPath) {
  const abs = path.join(process.cwd(), "public", relPath);
  const buf = fs.readFileSync(abs);
  const name = path.basename(abs);
  const mime = name.endsWith(".mp3")
    ? "audio/mpeg"
    : name.endsWith(".png")
      ? "image/png"
      : "image/jpeg";
  const form = new FormData();
  form.append("file", new Blob([buf], { type: mime }), name);
  form.append("uploadPath", "heliosgen");
  form.append("fileName", name);
  const res = await fetch(UPLOAD, { method: "POST", headers: authBearer, body: form });
  const body = await res.json().catch(() => ({}));
  const url = body?.data?.downloadUrl ?? body?.data?.fileUrl;
  if (!url) throw new Error(`upload failed ${relPath}: ${JSON.stringify(body).slice(0, 200)}`);
  return url;
}

async function submit(label, model, input) {
  const res = await fetch(CREATE, {
    method: "POST",
    headers: authJson,
    body: JSON.stringify({ model, input }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    label,
    model,
    http: res.status,
    code: body.code,
    msg: body.msg,
    taskId: body?.data?.taskId ?? null,
    t0: Date.now(),
  };
}

async function record(taskId) {
  const res = await fetch(`${RECORD}?taskId=${encodeURIComponent(taskId)}`, { headers: authBearer });
  const body = await res.json().catch(() => ({}));
  return body.data ?? {};
}

const SHORT_IMG = "A simple still life: one red apple on a white table, soft daylight, photorealistic.";
const SHORT_VID = "A person walks slowly across a quiet warehouse aisle. Fixed camera, natural motion.";

console.log("Uploading face + audio for avatar/talking probes…");
const FACE = await uploadLocal("generated/uploads/43048fff-ee87-4478-bc71-83f0415fc76a.jpg");
const AUDIO = await uploadLocal("generated/references/2510d8cb-49d8-4bdb-bac2-b468ca08f6f3.mp3");
console.log("face:", FACE);
console.log("audio:", AUDIO);

const JOBS = [
  {
    label: "1. Kling 3.0",
    model: "kling-3.0/video",
    input: {
      prompt: SHORT_VID,
      aspect_ratio: "9:16",
      duration: "5",
      mode: "std",
      sound: false,
      multi_shots: false,
      multi_prompt: [],
      kling_elements: [],
    },
  },
  {
    label: "2. Seedance 2.5",
    model: "bytedance/seedance-2-5",
    input: {
      prompt: SHORT_VID,
      aspect_ratio: "9:16",
      duration: 4,
      resolution: "720p",
      generate_audio: false,
      web_search: false,
    },
  },
  {
    label: "3a. Seedance 2.0",
    model: "bytedance/seedance-2",
    input: {
      prompt: SHORT_VID,
      aspect_ratio: "9:16",
      duration: 4,
      resolution: "720p",
      generate_audio: false,
      web_search: false,
    },
  },
  {
    label: "3b. Seedance 2.0 Mini",
    model: "bytedance/seedance-2-mini",
    input: {
      prompt: SHORT_VID,
      aspect_ratio: "9:16",
      duration: 4,
      resolution: "720p",
      generate_audio: false,
      web_search: false,
    },
  },
  {
    label: "4. Nano Banana Pro",
    model: "nano-banana-pro",
    input: {
      prompt: SHORT_IMG,
      aspect_ratio: "1:1",
      quality: "basic",
      output_format: "jpg",
    },
  },
  {
    label: "5. GPT Image 2",
    model: "gpt-image-2-text-to-image",
    input: {
      prompt: SHORT_IMG,
      aspect_ratio: "1:1",
      quality: "medium",
    },
  },
  {
    label: "6. Seedream 5.0 Pro",
    model: "seedream/5-pro-text-to-image",
    input: {
      prompt: SHORT_IMG,
      aspect_ratio: "1:1",
      quality: "basic",
      nsfw_checker: false,
    },
  },
  {
    label: "7. Gemini Omni Video",
    model: "gemini-omni-video",
    input: {
      prompt: SHORT_VID,
      duration: "4",
      aspect_ratio: "9:16",
      resolution: "720p",
    },
  },
  {
    label: "8+9. Kling AI Avatar Standard / Talking lip-sync",
    model: "kling/ai-avatar-standard",
    input: {
      image_url: FACE,
      audio_url: AUDIO,
      prompt: "Lip-sync naturally with slight head motion.",
    },
  },
  {
    label: "10+11. Kling AI Avatar Pro / Talking pro lip-sync",
    model: "kling/ai-avatar-pro",
    input: {
      image_url: FACE,
      audio_url: AUDIO,
      prompt: "Lip-sync naturally with slight head motion.",
    },
  },
  {
    // Talking "generate voice" path (no uploaded audio) starts with Gemini Flash TTS.
    label: "9b. Talking TTS (google/gemini-3-1-flash-tts)",
    model: "google/gemini-3-1-flash-tts",
    input: {
      temperature: 1,
      sample_context: "Clear spoken narration for a short talking-head video.",
      speakers: [{
        speaker_id: "Speaker 1",
        voice_name: "Kore",
        accent: "American (Gen)",
        style: "Newscaster",
        pace: "Natural",
      }],
      dialogue_turns: [{ speaker_id: "Speaker 1", text: "Hello, this is a short HeliosGen talking-mode voice check." }],
    },
  },
];

const started = [];
for (const job of JOBS) {
  const r = await submit(job.label, job.model, job.input);
  started.push(r);
  console.log(
    `[submit] ${job.label} model=${job.model} http=${r.http} code=${r.code} task=${r.taskId ?? "-"} ${r.msg ?? ""}`,
  );
}

const live = started.filter((s) => s.taskId);
const settled = new Map();
const MAX_WAIT_MS = 8 * 60 * 1000;

while (settled.size < live.length && Date.now() - Math.min(...live.map((s) => s.t0)) < MAX_WAIT_MS) {
  await new Promise((r) => setTimeout(r, 5000));
  for (const s of live) {
    if (settled.has(s.taskId)) continue;
    const d = await record(s.taskId);
    const state = String(d.state ?? d.status ?? "").toLowerCase();
    const secs = Math.round((Date.now() - s.t0) / 1000);
    if (["fail", "failed", "error"].includes(state)) {
      settled.set(s.taskId, {
        verdict: "FAIL",
        secs,
        detail: `code=${d.failCode ?? d.errorCode} msg=${d.failMsg ?? d.errorMessage ?? ""} credits=${d.creditsConsumed ?? "?"}`,
      });
      console.log(`[${secs}s] ${s.label} => FAIL ${settled.get(s.taskId).detail}`);
    } else if (state === "success") {
      settled.set(s.taskId, {
        verdict: "PASS",
        secs,
        detail: `credits=${d.creditsConsumed ?? "?"}`,
      });
      console.log(`[${secs}s] ${s.label} => PASS ${settled.get(s.taskId).detail}`);
    } else {
      console.log(`[${secs}s] ${s.label} ... ${state || "waiting"}`);
    }
  }
}

console.log("\n===== CLIENT MODEL VERIFICATION =====");
for (const s of started) {
  if (s.code !== 200 || !s.taskId) {
    console.log(`${s.label.padEnd(55)} SUBMIT-REJECT http=${s.http} code=${s.code} ${s.msg ?? ""}`);
    continue;
  }
  const r = settled.get(s.taskId);
  if (!r) {
    console.log(`${s.label.padEnd(55)} TIMEOUT (still running / unresolved)`);
    continue;
  }
  console.log(`${s.label.padEnd(55)} ${r.verdict} (${r.secs}s) ${r.detail}`);
}
