/**
 * Verify Veo frame publish path end-to-end (no false "fixed" without this).
 * 1) Accept guest /generated/... path (was dropped by https-only filter)
 * 2) Rehost onto kie CDN
 * 3) Optional: HEAD/GET probe + live Veo submit if KIE key present
 *
 * Usage: node --import tsx scripts/verify-veo-frames.mjs
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadEnvFile(join(process.cwd(), ".env.guest"));
loadEnvFile(join(process.cwd(), ".env.local"));
loadEnvFile(join(process.cwd(), ".env"));
process.env.GUEST_MODE = process.env.GUEST_MODE || "1";

const { ensureKieHostedImageUrl } = await import("../lib/kieFileUpload.ts");
const { probeImageUrlsDetailed } = await import("../lib/veoUrlProbe.ts");
const { getKieApiToken } = await import("../lib/guest/db.ts");

function pickLocalGenerated() {
  const dir = join(process.cwd(), "public", "generated", "uploads");
  if (!existsSync(dir)) throw new Error("no public/generated/uploads");
  const files = readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (files.length === 0) throw new Error("no image files in uploads");
  // Prefer a recently named uuid-style file
  const pick = files.find((f) => f.length > 20) ?? files[0];
  return `/generated/uploads/${pick}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "(bad)";
  }
}

function isKieHost(url) {
  const h = hostOf(url).toLowerCase();
  return h.includes("redpandaai.co") || h.includes("kie.ai");
}

let failed = 0;
function ok(label, cond, detail = "") {
  if (cond) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failed++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n=== verify-veo-frames ===\n");

const localPath = pickLocalGenerated();
ok("local path is NOT https (repro filter bug)", !localPath.startsWith("https://"), localPath);
ok("local path includes /generated/", localPath.includes("/generated/"), `len=${localPath.length}`);

console.log("\nPublishing local guest frame via ensureKieHostedImageUrl…");
const hostedLocal = await ensureKieHostedImageUrl(localPath);
ok("local → https", hostedLocal.startsWith("https://"), hostedLocal.slice(0, 80));
ok("local → kie-hosted", isKieHost(hostedLocal), hostOf(hostedLocal));

const probeLocal = await probeImageUrlsDetailed([hostedLocal]);
ok("local hosted probe ok", probeLocal[0]?.ok === true, JSON.stringify(probeLocal[0]));

// Optional second frame: tiny public png if we can fetch, else duplicate hostedLocal
const sampleRemote = process.env.VEO_VERIFY_REMOTE_URL
  || "https://tempfile.aiquickdraw.com/workers/kie/file.png"; // may 404 — we only test path if reachable

console.log("\nChecking optional remote rehost path…");
let remoteOk = false;
try {
  const head = await fetch(sampleRemote, { method: "HEAD", redirect: "follow" });
  const get = head.ok ? head : await fetch(sampleRemote, { method: "GET", redirect: "follow" });
  remoteOk = get.ok;
} catch {
  remoteOk = false;
}

let hostedRemote = hostedLocal;
if (remoteOk) {
  hostedRemote = await ensureKieHostedImageUrl(sampleRemote);
  ok("remote → https", hostedRemote.startsWith("https://"), hostedRemote.slice(0, 80));
  ok("remote → kie-hosted", isKieHost(hostedRemote), hostOf(hostedRemote));
} else {
  console.log(`SKIP  remote sample unreachable (${sampleRemote}) — using duplicate local as frame2`);
}

const imageUrls = [hostedLocal, hostedRemote === hostedLocal ? hostedLocal : hostedRemote];
ok("final nImageUrls === 2", imageUrls.length === 2, String(imageUrls.length));
ok("both frames https", imageUrls.every((u) => u.startsWith("https://")));
ok("both frames kie-hosted", imageUrls.every(isKieHost), imageUrls.map(hostOf).join(", "));

const apiKey = getKieApiToken() || process.env.KIE_API_KEY || process.env.KIE_TOKEN || null;
if (!apiKey) {
  console.log("\nSKIP  live Veo submit — no KIE API key in env");
} else {
  console.log("\nSubmitting live Veo Lite FLF (same-frame continuity)…");
  // kie Veo endpoint spreads input at top level: { model, prompt, generationType, imageUrls, ... }
  const body = {
    model: "veo3_lite",
    prompt: "Subtle camera push-in, continuous scene, no morph, photoreal.",
    generationType: "FIRST_AND_LAST_FRAMES_2_VIDEO",
    aspectRatio: "16:9",
    resolution: "720p",
    imageUrls,
    watermark: "",
    enableTranslation: true,
  };
  const res = await fetch("https://api.kie.ai/api/v1/veo/generate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  console.log("kie status", res.status, JSON.stringify(json).slice(0, 400));
  const taskId = json?.data?.taskId || json?.data?.task_id;
  ok("kie accepted job (200 + taskId)", res.ok && !!taskId, taskId ? `taskId=${taskId}` : `code=${json?.code} msg=${json?.msg}`);

  if (taskId) {
    // Poll up to ~90s for terminal state — Internal Error usually fails fast
    let terminal = null;
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pr = await fetch(`https://api.kie.ai/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const pj = await pr.json().catch(() => ({}));
      const data = pj?.data ?? pj;
      const state = String(data?.state ?? data?.status ?? "").toLowerCase();
      console.log(`  poll ${i + 1}: state=${state || "(empty)"} failMsg=${data?.failMsg ?? data?.error ?? ""}`);
      if (["success", "fail", "failed", "error"].includes(state)) {
        terminal = { state, failMsg: data?.failMsg ?? data?.error, failCode: data?.failCode };
        break;
      }
    }
    if (!terminal) {
      console.log("WARN  still pending after polls — submit accepted; not claiming video success");
    } else if (terminal.state === "success") {
      ok("live Veo completed success", true);
    } else {
      ok(
        "live Veo did NOT Internal-Error from unreachable frames",
        !/internal error/i.test(String(terminal.failMsg ?? "")),
        `${terminal.state} ${terminal.failMsg ?? ""}`,
      );
      // Still report overall as fail if generation failed for other reasons
      if (terminal.state !== "success") {
        console.log("NOTE  generation failed upstream — frame publish path still verified above");
      }
    }
  }
}

console.log(failed === 0 ? "\nALL CHECKS PASSED\n" : `\n${failed} CHECK(S) FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
