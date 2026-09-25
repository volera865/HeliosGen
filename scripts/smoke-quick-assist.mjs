/**
 * Smoke test: Quick Assist → Auto-Apply
 *
 *   node --experimental-strip-types scripts/smoke-quick-assist.mjs
 *
 * Verifies parser, system prompt contract, model IDs / ratios from the
 * plan checklist, and that gallery + QuickAssist are wired for Apply.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseQuickAssistResponse } from "../lib/quickAssistApply.ts";
import { IMAGE_MODELS, VIDEO_MODELS } from "../lib/modelConfig.ts";
import { SYSTEM_PROMPT } from "../lib/systemPrompt.ts";

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

function assert(name, cond, failDetail) {
  if (cond) pass(name);
  else fail(name, failDetail || "assertion failed");
}

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 56 - title.length))}`);
}

/** Mirror gallery validation for model / ratio / video fields. */
function resolveApply(payload) {
  const { settings } = payload;
  const registry = settings.page === "video" ? VIDEO_MODELS : IMAGE_MODELS;
  const model =
    registry.find((m) => m.id === settings.model) ?? registry[0];
  if (!model) return { ok: false, reason: "empty registry" };

  const modelMatched = model.id === settings.model;
  let aspectRatio = null;
  if (model.ratios.length > 0) {
    aspectRatio =
      (settings.aspectRatio && model.ratios.includes(settings.aspectRatio)
        ? settings.aspectRatio
        : null) ??
      ("defaultRatio" in model ? model.defaultRatio : null) ??
      model.ratios[0];
  }

  const out = {
    ok: true,
    modelMatched,
    modelId: model.id,
    aspectRatio,
    resolution: undefined,
    duration: undefined,
    talkingMode: undefined,
    sound: undefined,
  };

  if (settings.page === "video") {
    const resolutions = model.resolutions ?? [];
    if (resolutions.length > 0) {
      out.resolution =
        (settings.resolution && resolutions.includes(settings.resolution)
          ? settings.resolution
          : null) ??
        model.defaultResolution ??
        resolutions[0];
    }
    const durations = model.durations ?? [];
    if (durations.length > 0) {
      out.duration =
        (typeof settings.duration === "number" &&
        durations.includes(settings.duration)
          ? settings.duration
          : null) ??
        model.defaultDuration ??
        durations[0];
    }
    if (typeof settings.talkingMode === "boolean") {
      out.talkingMode = settings.talkingMode;
    }
    if (settings.talkingMode === true) {
      out.sound = true;
    } else if (typeof settings.sound === "boolean") {
      out.sound = model.sound ? settings.sound : false;
    }
  }

  return out;
}

// ── 1. System prompt contract ─────────────────────────────────────────────────
section("System prompt");

assert(
  "SYSTEM_PROMPT requires JSON object",
  /Return ONLY a valid JSON object/i.test(SYSTEM_PROMPT) &&
    /"prompt"/i.test(SYSTEM_PROMPT) &&
    /"settings"/i.test(SYSTEM_PROMPT),
  "missing JSON output instructions",
);
assert(
  "SYSTEM_PROMPT lists image model ids",
  SYSTEM_PROMPT.includes("nano-banana-pro") &&
    SYSTEM_PROMPT.includes("seedream-5-pro"),
);
assert(
  "SYSTEM_PROMPT lists video model ids",
  SYSTEM_PROMPT.includes("seedance-2") &&
    SYSTEM_PROMPT.includes("gemini-omni-video"),
);

// ── 2. Parser ─────────────────────────────────────────────────────────────────
section("Parser");

{
  const raw = JSON.stringify({
    prompt: "A product poster.",
    settings: {
      page: "image",
      model: "nano-banana-pro",
      aspectRatio: "2:3",
    },
  });
  const p = parseQuickAssistResponse(raw);
  assert("parses plain JSON", !!p && p.prompt === "A product poster." && p.settings.model === "nano-banana-pro");
}

{
  const raw = "```json\n" + JSON.stringify({
    prompt: "Talking head.",
    settings: {
      page: "video",
      model: "seedance-2",
      aspectRatio: "9:16",
      resolution: "720p",
      duration: 10,
      talkingMode: true,
      sound: true,
    },
  }) + "\n```";
  const p = parseQuickAssistResponse(raw);
  assert(
    "parses fenced JSON",
    !!p && p.settings.page === "video" && p.settings.talkingMode === true,
  );
}

{
  const raw = "Here you go:\n" + JSON.stringify({
    prompt: "x",
    settings: { page: "image", model: "nano-banana-pro" },
  }) + "\nThanks!";
  const p = parseQuickAssistResponse(raw);
  assert("parses JSON with surrounding prose", !!p && p.prompt === "x");
}

assert("plain text → null (no Apply)", parseQuickAssistResponse("just make it cinematic") === null);
assert("empty → null", parseQuickAssistResponse("") === null);
assert(
  "missing settings → null",
  parseQuickAssistResponse(JSON.stringify({ prompt: "hi" })) === null,
);
assert(
  "bad page → null",
  parseQuickAssistResponse(JSON.stringify({
    prompt: "hi",
    settings: { page: "audio", model: "x" },
  })) === null,
);

// ── 3. Checklist scenarios (parse + validate against modelConfig) ─────────────
section("Plan checklist scenarios");

const scenarios = [
  {
    name: "1. poster → image nano-banana-pro 2:3",
    json: {
      prompt: "Poster of product on clean backdrop. NEGATIVE PROMPT: blurry label",
      settings: { page: "image", model: "nano-banana-pro", aspectRatio: "2:3" },
    },
    expect: { modelId: "nano-banana-pro", aspectRatio: "2:3", modelMatched: true },
  },
  {
    name: "2. explains to camera → seedance-2 talking+sound",
    json: {
      prompt: "Woman explains product to camera.",
      settings: {
        page: "video",
        model: "seedance-2",
        aspectRatio: "9:16",
        resolution: "720p",
        duration: 10,
        talkingMode: true,
        sound: true,
      },
    },
    expect: {
      modelId: "seedance-2",
      modelMatched: true,
      talkingMode: true,
      sound: true,
      aspectRatio: "9:16",
    },
  },
  {
    name: "3. jar then capsules → gemini-omni-video 9:16",
    json: {
      prompt: "CLIP 1 jar. HARD CUT. CLIP 2 capsules.",
      settings: {
        page: "video",
        model: "gemini-omni-video",
        aspectRatio: "9:16",
        resolution: "720p",
        duration: 8,
        talkingMode: false,
        sound: false,
      },
    },
    expect: {
      modelId: "gemini-omni-video",
      modelMatched: true,
      aspectRatio: "9:16",
    },
  },
  {
    name: "4. square feed → nano-banana-pro 1:1",
    json: {
      prompt: "Square feed post.",
      settings: { page: "image", model: "nano-banana-pro", aspectRatio: "1:1" },
    },
    expect: { modelId: "nano-banana-pro", aspectRatio: "1:1", modelMatched: true },
  },
  {
    name: "5. TikTok ad → seedance-2 9:16 sound",
    json: {
      prompt: "Vertical TikTok style product ad.",
      settings: {
        page: "video",
        model: "seedance-2",
        aspectRatio: "9:16",
        resolution: "720p",
        duration: 6,
        talkingMode: false,
        sound: true,
      },
    },
    expect: {
      modelId: "seedance-2",
      modelMatched: true,
      aspectRatio: "9:16",
      sound: true,
    },
  },
];

for (const s of scenarios) {
  const parsed = parseQuickAssistResponse(JSON.stringify(s.json));
  if (!parsed) {
    fail(s.name, "parser returned null");
    continue;
  }
  const resolved = resolveApply(parsed);
  if (!resolved.ok) {
    fail(s.name, resolved.reason);
    continue;
  }
  const mismatches = [];
  for (const [k, v] of Object.entries(s.expect)) {
    if (resolved[k] !== v) mismatches.push(`${k}=${JSON.stringify(resolved[k])} (want ${JSON.stringify(v)})`);
  }
  if (mismatches.length) fail(s.name, mismatches.join("; "));
  else pass(s.name, `model=${resolved.modelId} ratio=${resolved.aspectRatio}`);
}

{
  // Invalid model id → fall back to registry[0], still applyable
  const parsed = parseQuickAssistResponse(JSON.stringify({
    prompt: "x",
    settings: { page: "image", model: "not-a-real-model", aspectRatio: "1:1" },
  }));
  const resolved = resolveApply(parsed);
  assert(
    "invalid model → fallback to registry[0]",
    resolved.ok && !resolved.modelMatched && resolved.modelId === IMAGE_MODELS[0].id,
    `got ${resolved.modelId}`,
  );
}

{
  const nb = IMAGE_MODELS.find((m) => m.id === "nano-banana-pro");
  const parsed = parseQuickAssistResponse(JSON.stringify({
    prompt: "x",
    settings: { page: "image", model: "nano-banana-pro", aspectRatio: "99:99" },
  }));
  const resolved = resolveApply(parsed);
  const expected =
    ("defaultRatio" in nb ? nb.defaultRatio : null) ?? nb.ratios[0];
  assert(
    "invalid ratio → model default",
    resolved.aspectRatio === expected,
    `got ${resolved.aspectRatio}, want ${expected}`,
  );
}

// ── 4. Wiring (source checks) ─────────────────────────────────────────────────
section("Source wiring");

const qaSrc = readFileSync(join(root, "components/QuickAssist.tsx"), "utf8");
const galSrc = readFileSync(join(root, "app/gallery/page.tsx"), "utf8");
const wfSrc = readFileSync(join(root, "app/workflow/[id]/page.tsx"), "utf8");

assert("QuickAssist exports onApply prop", /onApply\?:/.test(qaSrc) || /onApply,/.test(qaSrc));
assert("QuickAssist shows Apply to compose", qaSrc.includes("Apply to compose"));
assert("QuickAssist max_tokens >= 4096", /max_tokens:\s*4096/.test(qaSrc));
assert("QuickAssist parses on stream complete", qaSrc.includes("parseQuickAssistResponse"));
assert("Gallery wires onApply", galSrc.includes("onApply={handleQuickAssistApply}"));
assert("Gallery has pendingApplyRef", galSrc.includes("pendingApplyRef"));
assert("Gallery has applyComposeFromAssist", galSrc.includes("applyComposeFromAssist"));
assert(
  "Workflow QuickAssist has no onApply",
  /<QuickAssist\s*\/>/.test(wfSrc) && !wfSrc.includes("onApply="),
);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Summary ${"─".repeat(48)}`);
console.log(`PASS ${counts.PASS}  FAIL ${counts.FAIL}`);
process.exit(counts.FAIL > 0 ? 1 : 0);
