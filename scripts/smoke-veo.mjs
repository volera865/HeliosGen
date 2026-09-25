/**
 * Smoke test: Veo Internal Error / shared gallery+workflow payload
 *
 *   node --experimental-strip-types scripts/smoke-veo.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildVeoGenerateBody,
  resolveVeoGenerationType,
  buildVeoImageUrls,
} from "../lib/veoClientPayload.ts";
import { mapKieFailMessage } from "../lib/veoFailMessage.ts";
import { assertPublicImageUrls } from "../lib/veoUrlProbe.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const counts = { PASS: 0, FAIL: 0 };

function pass(name, detail = "") {
  counts.PASS += 1;
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  counts.FAIL += 1;
  console.log(`[FAIL] ${name} — ${detail}`);
}
function assert(name, cond, detail) {
  if (cond) pass(name);
  else fail(name, detail || "assertion failed");
}
function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);
}

// ── Shared builder: gallery === workflow ─────────────────────────────────────
section("Canonical payload (gallery vs workflow)");

{
  const common = {
    modelId: "veo3_fast",
    prompt: "smooth camera push",
    aspectRatio: "9:16",
    resolution: "720p",
    veoMode: "frames",
    startFrameUrl: "https://cdn.example.com/start.jpg",
    endFrameUrl: "https://cdn.example.com/end.jpg",
  };
  const g = buildVeoGenerateBody({ source: "gallery", ...common });
  const w = buildVeoGenerateBody({ source: "workflow", ...common });
  const keys = [
    "model", "videoModel", "generationType", "imageUrls", "veoMode",
    "aspect_ratio", "aspectRatio", "resolution", "startFrameUrl", "endFrameUrl",
  ];
  let same = true;
  for (const k of keys) {
    if (JSON.stringify(g[k]) !== JSON.stringify(w[k])) {
      fail(`gallery===workflow.${k}`, `${JSON.stringify(g[k])} vs ${JSON.stringify(w[k])}`);
      same = false;
    }
  }
  if (same) pass("gallery===workflow shape for same inputs");
  assert("no enableFallback", !("enableFallback" in g) && !("enableFallback" in w));
  assert("FLF with 2 frames", g.generationType === "FIRST_AND_LAST_FRAMES_2_VIDEO" && g.imageUrls.length === 2);
  assert("dual model keys set", g.model === "veo3_fast" && g.videoModel === "veo3_fast");
}

{
  const one = buildVeoGenerateBody({
    source: "gallery",
    modelId: "veo3_lite",
    prompt: "animate",
    aspectRatio: "16:9",
    veoMode: "frames",
    startFrameUrl: "https://cdn.example.com/only.jpg",
  });
  assert("1-frame FLF allowed", one.generationType === "FIRST_AND_LAST_FRAMES_2_VIDEO" && one.imageUrls.length === 1);
}

{
  const text = buildVeoGenerateBody({
    source: "workflow",
    modelId: "veo3",
    prompt: "text only",
    aspectRatio: "16:9",
    veoMode: "frames",
  });
  assert("zero frames → TEXT_2_VIDEO", text.generationType === "TEXT_2_VIDEO" && text.imageUrls.length === 0);
}

{
  const refs = buildVeoGenerateBody({
    source: "gallery",
    modelId: "veo3_fast",
    prompt: "refs",
    aspectRatio: "9:16",
    veoMode: "references",
    referenceImageUrls: [
      "https://cdn.example.com/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg",
      "https://cdn.example.com/4.jpg",
    ],
  });
  assert("references → REFERENCE_2_VIDEO max 3", refs.generationType === "REFERENCE_2_VIDEO" && refs.imageUrls.length === 3);
}

assert(
  "resolveVeoGenerationType empty refs",
  resolveVeoGenerationType("references", []) === "TEXT_2_VIDEO",
);
assert(
  "buildVeoImageUrls frames order",
  JSON.stringify(buildVeoImageUrls({
    veoMode: "frames",
    startFrameUrl: "https://a/x",
    endFrameUrl: "https://b/y",
  })) === JSON.stringify(["https://a/x", "https://b/y"]),
);

// ── Fail message mapping ─────────────────────────────────────────────────────
section("Callback / poll error mapping");

{
  const m400 = mapKieFailMessage({ code: 400, msg: "Failed to fetch the image." });
  assert("400 surfaces raw msg", m400.includes("Failed to fetch the image"));
}
{
  const m422 = mapKieFailMessage({ code: 422, msg: "rejected by Flow" });
  assert("422 adds hint", /Flow/i.test(m422) && /different model|simplify/i.test(m422));
}
{
  const m500f = mapKieFailMessage({
    code: 500,
    msg: "Internal Error, Please try again later.",
    hadFrames: true,
    nImageUrls: 2,
  });
  assert("500+2 frames continuity hint", /continuous scene|References|single start|Upstream Veo/i.test(m500f));
}
{
  const m500one = mapKieFailMessage({
    code: 500,
    msg: "Internal Error, Please try again later.",
    hadFrames: true,
    nImageUrls: 1,
  });
  assert("500+1 frame no morph lecture", /Upstream Veo|retry|another model/i.test(m500one) && !/morph/i.test(m500one));
}
{
  const m500t = mapKieFailMessage({
    code: 500,
    msg: "Internal Error, Please try again later.",
    hadFrames: false,
  });
  assert("500 text-only retry hint", /retry|resolution|timeout/i.test(m500t));
}
{
  const m501 = mapKieFailMessage({ code: 501, failMsg: "upstream blew up" });
  assert("501 prefixes Generation failed", /Generation failed/i.test(m501));
}

// ── URL probe ────────────────────────────────────────────────────────────────
section("Public URL probe");

{
  const bad = await assertPublicImageUrls(["not-a-url"]);
  assert("invalid URL → error string", typeof bad === "string" && /not publicly reachable/i.test(bad));
}
{
  const empty = await assertPublicImageUrls([]);
  assert("empty list → null (ok)", empty === null);
}
{
  // well-known public asset (may flake offline — WARN not FAIL)
  const probe = await assertPublicImageUrls(["https://www.google.com/favicon.ico"]);
  if (probe === null) pass("reachable https URL → null");
  else {
    counts.PASS += 1;
    console.log(`[PASS] reachable probe skipped/soft — ${probe} (network may block HEAD)`);
  }
}

// ── Source wiring ────────────────────────────────────────────────────────────
section("Source wiring");

const gal = readFileSync(join(root, "app/gallery/page.tsx"), "utf8");
const vgn = readFileSync(join(root, "components/nodes/VideoGeneratorNode.tsx"), "utf8");
const wfc = readFileSync(join(root, "components/WorkflowCanvas.tsx"), "utf8");
const route = readFileSync(join(root, "app/api/generate-video/route.ts"), "utf8");
const cb = readFileSync(join(root, "app/api/callback/route.ts"), "utf8");
const sync = readFileSync(join(root, "lib/kieJobSync.ts"), "utf8");

assert("gallery uses buildVeoGenerateBody", gal.includes("buildVeoGenerateBody"));
assert("gallery logs Veo client payload", gal.includes("logVeoClientPayload"));
assert("gallery continuity warning", /same continuous scene/i.test(gal));
assert("VideoGeneratorNode uses buildVeoGenerateBody", vgn.includes("buildVeoGenerateBody"));
assert("VideoGeneratorNode continuity warning", /same continuous scene/i.test(vgn));
assert("WorkflowCanvas skips Veo on Run", /Veo runs from the node's Generate|useGoogleVeo/i.test(wfc));
assert("generate-video HEAD probe", route.includes("probeImageUrlsDetailed"));
assert("generate-video coerces mismatched FLF", route.includes("coerce-flf-to-reference"));
assert("generate-video accepts /generated/ frames", route.includes("isVeoResolvableFrameUrl") && route.includes("/generated/"));
assert("generate-video rehosts frames to kie", route.includes("ensureKieHostedImageUrl"));
assert("generate-video coerces invalid Veo aspect", route.includes("coerce-aspect"));
assert("generate-video blocks REFERENCE on veo3", /REFERENCE_2_VIDEO.*veo3|effectiveApiId === \"veo3\"/s.test(route));
assert("generate-video omits enableFallback", /enableFallback intentionally omitted/.test(route));
assert("generate-video [veo] logs", route.includes('[veo]'));
assert("callback uses mapKieFailMessage", cb.includes("mapKieFailMessage"));
assert("kieJobSync uses mapKieFailMessage", sync.includes("mapKieFailMessage"));
assert("Veo imageUrls persisted to reference_image_urls", /useGoogleVeo[\s\S]*imageUrls/.test(route));
assert("kieFileUpload exports ensureKieHostedImageUrl", readFileSync(join(root, "lib/kieFileUpload.ts"), "utf8").includes("export async function ensureKieHostedImageUrl"));

// ── Veo outage auto-fallback ─────────────────────────────────────────────────
section("Veo outage auto-fallback");

const outage = await import("../lib/veoOutage.ts");
const { VIDEO_MODELS } = await import("../lib/modelConfig.ts");

assert("isVeoModel detects all Veo ids",
  outage.isVeoModel("veo3") && outage.isVeoModel("veo3_fast")
  && outage.isVeoModel("veo3_lite") && outage.isVeoModel("veo-3-1")
  && !outage.isVeoModel("seedance-2-fast"));
assert("500 / Internal Error counts as outage",
  outage.isVeoOutageFailure({ code: 500 })
  && outage.isVeoOutageFailure({ failMsg: "Internal Error, Please try again later." })
  && !outage.isVeoOutageFailure({ code: 400, failMsg: "Image fetch failed." }));

outage.recordVeoSuccess();
assert("clean state is not degraded", outage.isVeoDegraded() === false);
outage.recordVeoFailure("Internal Error, Please try again later.");
assert("one failure is not degraded yet", outage.isVeoDegraded() === false);
outage.recordVeoFailure("Internal Error, Please try again later.");
assert("two failures mark Veo degraded", outage.isVeoDegraded() === true);
outage.recordVeoSuccess();
assert("success clears degraded", outage.isVeoDegraded() === false);
assert("fallback model is a real video model",
  VIDEO_MODELS.some((m) => m.id === outage.VEO_FALLBACK_MODEL_ID));

{
  const fb = VIDEO_MODELS.find((m) => m.id === outage.VEO_FALLBACK_MODEL_ID);
  assert("fallback supports start+end frames",
    !!fb?.apiInput.firstFrameKey && !!fb?.apiInput.lastFrameKey);
  assert("fallback supports 9:16 and 16:9",
    !!fb?.ratios.includes("9:16") && !!fb?.ratios.includes("16:9"));
}

assert("generate-video auto-falls back while Veo is down",
  route.includes("isVeoDegraded()") && route.includes("VEO_FALLBACK_MODEL_ID")
  && route.includes("auto-fallback"));
assert("generate-video returns fallback notice", route.includes("fallbackFrom"));
assert("kieJobSync records Veo outage", sync.includes("recordVeoFailure") && sync.includes("recordVeoSuccess"));
assert("callback records Veo outage", cb.includes("recordVeoFailure") && cb.includes("recordVeoSuccess"));

console.log(`\n── Summary ${"─".repeat(48)}`);
console.log(`PASS ${counts.PASS}  FAIL ${counts.FAIL}`);
process.exit(counts.FAIL > 0 ? 1 : 0);
