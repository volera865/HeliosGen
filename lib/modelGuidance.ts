import { IMAGE_MODELS, VIDEO_MODELS, type VideoHandle } from "@/lib/modelConfig";

export type ModelGuidanceContext = {
  tab: "images" | "videos";
  modelId: string;
  hasPrompt: boolean;
  hasRefImages: boolean;
  refImageCount: number;
  hasStartFrame: boolean;
  hasEndFrame: boolean;
  hasResources: boolean;
  resourceCount: number;
  hasReferenceVideo: boolean;
  hasMotionVideoRef: boolean;
  hasAudioRef: boolean;
  hasElements: boolean;
  talkingMode: boolean;
  sound: boolean;
};

export type ModelGuidanceResult = {
  summary: string;
  fit: "good" | "ok" | "mismatch";
  scenarioLabel?: string;
  tips?: string[];
  suggestion?: { modelId: string; label: string; reason: string };
};

/** Static one-liners for model dropdown (capability headline). */
const DROPDOWN_BLURBS: Record<string, string> = {
  "google-nano-banana": "Text-to-image only.",
  "nano-banana-2": "Text + refs, quality tiers.",
  "nano-banana-pro": "Text + many reference images.",
  "nano-banana-2-lite": "Text + refs, fast drafts.",
  "z-image": "Stylized text-to-image.",
  "seedream-5-lite": "Lightweight stills.",
  "seedream-5-pro": "Higher-fidelity stills.",
  "grok-imagine-image": "Grok image, flexible ratios.",
  "gpt-image-2": "Azure GPT Image layouts.",
  veo3_lite: "Text or 1–2 frames (no ref assets).",
  veo3_fast: "Text, frames, or reference images.",
  veo3: "Best Veo quality; frames + references.",
  "gemini-omni-video": "Text, refs, and reference video.",
  "kling-3.0": "Text, frames, refs, sound, elements.",
  "kling-3.0-turbo": "Fast text or start-frame video.",
  "kling-ai-avatar-standard": "Face image + audio lip-sync.",
  "kling-ai-avatar-pro": "Pro avatar lip-sync.",
  "grok-imagine": "Text + tagged reference images.",
  "grok-imagine-1-5-preview": "Reference image drives the clip.",
  "seedance-2": "Text, frames, refs, audio, ref video.",
  "seedance-2-fast": "Same inputs as Seedance 2, faster.",
  "seedance-2-mini": "Budget multimodal Seedance.",
  "seedance-2-5": "Long runs, heavy reference sets.",
  "seedance-2-5-edit": "Requires reference video to edit.",
  happyhorse: "Text, optional start frame + refs.",
  "kling-2.6-motion-control": "Subject frame + motion video.",
  "kling-3.0-motion-control": "Subject frame + motion video (3.0).",
};

type VideoScenarioId =
  | "empty"
  | "text_only"
  | "text_image"
  | "text_flf"
  | "text_refs"
  | "text_ref_video"
  | "text_audio"
  | "text_image_audio"
  | "image_audio"
  | "motion"
  | "talking";

type VideoScenario = { id: VideoScenarioId; label: string };

function modelName(modelId: string, tab: ModelGuidanceContext["tab"]): string {
  const list = tab === "videos" ? VIDEO_MODELS : IMAGE_MODELS;
  return list.find((m) => m.id === modelId)?.name ?? modelId;
}

function videoCfg(modelId: string) {
  return VIDEO_MODELS.find((m) => m.id === modelId);
}

export function guidanceForDropdownOption(modelId: string): string | undefined {
  return DROPDOWN_BLURBS[modelId];
}

function videoFlags(ctx: ModelGuidanceContext) {
  return {
    hasPrompt: ctx.hasPrompt,
    hasStartFrame: ctx.hasStartFrame,
    hasEndFrame: ctx.hasEndFrame,
    hasResources: ctx.hasResources || ctx.hasElements,
    hasReferenceVideo: ctx.hasReferenceVideo,
    hasMotionVideo: ctx.hasMotionVideoRef,
    hasAudioRef: ctx.hasAudioRef,
    talkingMode: ctx.talkingMode,
  };
}

export function classifyVideoScenario(ctx: ModelGuidanceContext): VideoScenario {
  const f = videoFlags(ctx);

  if (f.talkingMode) {
    return { id: "talking", label: "Image + audio (talking)" };
  }
  if (f.hasReferenceVideo) {
    return {
      id: "text_ref_video",
      label: f.hasPrompt ? "Text + reference video" : "Reference video",
    };
  }
  if (f.hasMotionVideo && f.hasStartFrame) {
    return { id: "motion", label: "Image + motion video" };
  }
  if (f.hasAudioRef && f.hasStartFrame && f.hasPrompt) {
    return { id: "text_image_audio", label: "Text + image + audio" };
  }
  if (f.hasAudioRef && f.hasStartFrame) {
    return { id: "image_audio", label: "Image + audio" };
  }
  if (f.hasAudioRef && f.hasPrompt) {
    return { id: "text_audio", label: "Text + audio" };
  }
  if (f.hasAudioRef) {
    return { id: "text_audio", label: "Audio reference" };
  }
  if (f.hasResources) {
    return {
      id: "text_refs",
      label: f.hasPrompt ? "Text + references" : "Reference images",
    };
  }
  if (f.hasStartFrame && f.hasEndFrame) {
    return {
      id: "text_flf",
      label: f.hasPrompt ? "Text + first & last frame" : "First & last frame",
    };
  }
  if (f.hasStartFrame) {
    return { id: "text_image", label: f.hasPrompt ? "Text + image" : "Start frame" };
  }
  if (f.hasPrompt) {
    return { id: "text_only", label: "Text" };
  }
  return { id: "empty", label: "No prompt or attachments" };
}

const HANDLE_LABELS: Record<VideoHandle, string> = {
  prompt: "text prompt",
  startFrame: "start frame",
  endFrame: "end frame",
  resource: "reference assets",
  videoRef: "motion video",
  referenceVideo: "reference video",
  audioRef: "audio reference",
};

export function modelSupportsScenario(
  modelId: string,
  ctx: ModelGuidanceContext,
): { supported: boolean; missing: string[] } {
  const cfg = videoCfg(modelId);
  if (!cfg) return { supported: true, missing: [] };

  const f = videoFlags(ctx);
  const handles = cfg.handles;
  const missing: string[] = [];

  const need = (active: boolean, handle: VideoHandle) => {
    if (!active) return;
    if (!handles.includes(handle)) {
      missing.push(HANDLE_LABELS[handle]);
    }
  };

  need(f.hasStartFrame, "startFrame");
  need(f.hasEndFrame, "endFrame");
  need(f.hasResources, "resource");
  need(f.hasReferenceVideo, "referenceVideo");
  need(f.hasMotionVideo, "videoRef");
  need(f.hasAudioRef, "audioRef");

  if (!cfg.promptOptional && !f.hasPrompt && !f.talkingMode && !cfg.apiInput.useKlingAiAvatar) {
    const onlyMotion = f.hasMotionVideo && f.hasStartFrame;
    if (!onlyMotion) missing.push(HANDLE_LABELS.prompt);
  }

  if (cfg.requiredHandles?.length) {
    for (const h of cfg.requiredHandles) {
      const has =
        h === "startFrame"
          ? f.hasStartFrame
          : h === "audioRef"
            ? f.hasAudioRef || f.talkingMode
            : h === "videoRef"
              ? f.hasMotionVideo
              : h === "referenceVideo"
                ? f.hasReferenceVideo
                : h === "resource"
                  ? f.hasResources
                  : h === "prompt"
                    ? f.hasPrompt
                    : false;
      if (!has) missing.push(HANDLE_LABELS[h]);
    }
  }

  if (f.hasMotionVideo && !f.hasStartFrame && handles.includes("videoRef")) {
    missing.push(HANDLE_LABELS.startFrame);
  }

  const unique = [...new Set(missing)];
  return { supported: unique.length === 0, missing: unique };
}

const SCENARIO_RECOMMEND: Record<VideoScenarioId, string[]> = {
  empty: ["veo3_lite"],
  text_only: ["veo3_lite", "veo3_fast", "kling-3.0-turbo"],
  text_image: ["veo3_lite", "veo3_fast", "kling-3.0-turbo"],
  text_flf: ["veo3_lite", "veo3_fast", "veo3"],
  text_refs: ["veo3_fast", "veo3", "kling-3.0"],
  text_ref_video: ["gemini-omni-video", "seedance-2-fast", "seedance-2"],
  text_audio: ["seedance-2-fast", "seedance-2", "kling-3.0"],
  text_image_audio: ["seedance-2-fast", "seedance-2", "seedance-2-5"],
  image_audio: ["kling-ai-avatar-standard", "kling-ai-avatar-pro"],
  motion: ["kling-3.0-motion-control", "kling-2.6-motion-control"],
  talking: [],
};

export function recommendModelForScenario(ctx: ModelGuidanceContext): string | undefined {
  const scenario = classifyVideoScenario(ctx);
  const candidates = SCENARIO_RECOMMEND[scenario.id];
  for (const id of candidates) {
    if (!VIDEO_MODELS.some((m) => m.id === id)) continue;
    const { supported } = modelSupportsScenario(id, ctx);
    if (supported && id !== ctx.modelId) return id;
  }
  for (const id of candidates) {
    if (id !== ctx.modelId && VIDEO_MODELS.some((m) => m.id === id)) return id;
  }
  return undefined;
}

function videoTips(ctx: ModelGuidanceContext, scenario: VideoScenario, modelId: string): string[] {
  const tips: string[] = [];
  const f = videoFlags(ctx);

  if (modelId === "veo3_lite" && f.hasResources) {
    tips.push("Veo Lite in this app does not use reference-image mode — try Veo Fast.");
  }
  if (scenario.id === "text_flf") {
    tips.push("Two frames define the opening and ending shot.");
  }
  if (scenario.id === "text_ref_video") {
    tips.push("Reference video slots count toward Gemini Omni quotas.");
  }
  if (f.hasAudioRef && !supportsHandle(modelId, "audioRef")) {
    tips.push("Attached audio is ignored by this model.");
  }
  if (ctx.sound && modelId.startsWith("veo3")) {
    tips.push("Veo does not generate sound — use Kling or Seedance.");
  }
  return tips.slice(0, 2);
}

function supportsHandle(modelId: string, handle: VideoHandle): boolean {
  return (videoCfg(modelId)?.handles ?? []).includes(handle);
}

function scenarioSummary(
  ctx: ModelGuidanceContext,
  scenario: VideoScenario,
  modelId: string,
  supported: boolean,
  missing: string[],
): string {
  const name = modelName(modelId, "videos");

  if (!supported && missing.length > 0) {
    return `${name} does not support ${missing.join(", ")} for this setup.`;
  }

  switch (scenario.id) {
    case "text_only":
      if (modelId === "veo3_lite") return "Good fit: cost-efficient text-to-video.";
      if (modelId === "veo3") return "Works, but Veo Fast or Lite is quicker for text-only drafts.";
      return `${name} handles text-only prompts.`;
    case "text_image":
      if (modelId.startsWith("veo3")) return "Good fit: frame-guided text-to-video.";
      return `${name} can use your start frame with a prompt.`;
    case "text_flf":
      return "Good fit: transition between your first and last frame.";
    case "text_refs":
      if (modelId === "veo3_lite") return "Reference assets will not be used — switch to Veo Fast.";
      return "Good fit: reference stills with your prompt.";
    case "text_ref_video":
      if (modelId === "gemini-omni-video") return "Good fit: prompt plus reference video and assets.";
      return `${name} may not fully use your reference video.`;
    case "text_audio":
    case "text_image_audio":
      if (supportsHandle(modelId, "audioRef")) return "Good fit: prompt with your audio reference.";
      return `${name} will not use attached audio.`;
    case "image_audio":
      return "Use Talking mode or an avatar model for lip-sync.";
    case "motion":
      if (modelId.includes("motion-control")) return "Good fit: motion from your reference video.";
      return "Pair subject frame with motion video via Motion Control.";
    case "empty":
      return "Add a prompt or attachment to generate.";
    default:
      return DROPDOWN_BLURBS[modelId] ?? `Generate with ${name}.`;
  }
}

function imageScenarioLabel(ctx: ModelGuidanceContext): string | undefined {
  if (!ctx.hasRefImages) return ctx.hasPrompt ? "Text" : undefined;
  return ctx.hasPrompt
    ? `Text + ${ctx.refImageCount} reference${ctx.refImageCount === 1 ? "" : "s"}`
    : `${ctx.refImageCount} reference${ctx.refImageCount === 1 ? "" : "s"}`;
}

export function getModelGuidance(ctx: ModelGuidanceContext): ModelGuidanceResult {
  if (ctx.tab === "videos" && ctx.talkingMode) {
    return {
      summary: "Talking mode routes face + audio through the avatar pipeline automatically.",
      fit: "good",
      scenarioLabel: "Image + audio (talking)",
      tips: ["Enable Talking and attach a face frame plus audio."],
    };
  }

  if (ctx.tab === "videos") {
    const scenario = classifyVideoScenario(ctx);
    const { supported, missing } = modelSupportsScenario(ctx.modelId, ctx);
    let fit: ModelGuidanceResult["fit"] = supported ? "good" : "mismatch";
    let summary = scenarioSummary(ctx, scenario, ctx.modelId, supported, missing);
    let suggestion: ModelGuidanceResult["suggestion"];
    const tips = videoTips(ctx, scenario, ctx.modelId);

    if (!supported) {
      const target = recommendModelForScenario(ctx);
      if (target) {
        suggestion = {
          modelId: target,
          label: modelName(target, "videos"),
          reason: `Better match for ${scenario.label.toLowerCase()}.`,
        };
      }
    } else if (scenario.id === "text_only" && ctx.modelId === "veo3") {
      fit = "ok";
      suggestion = {
        modelId: "veo3_fast",
        label: modelName("veo3_fast", "videos"),
        reason: "Text-only draft? Veo Fast is quicker for iterations.",
      };
    } else if (scenario.id === "text_refs" && ctx.modelId === "veo3_lite") {
      fit = "mismatch";
      const target = "veo3_fast";
      suggestion = {
        modelId: target,
        label: modelName(target, "videos"),
        reason: "Reference assets need Veo Fast or Quality.",
      };
      summary = scenarioSummary(ctx, scenario, ctx.modelId, false, ["reference assets"]);
    }

    if (suggestion?.modelId === ctx.modelId) suggestion = undefined;

    return {
      summary,
      fit,
      scenarioLabel: scenario.label,
      tips: tips.length ? tips : undefined,
      suggestion,
    };
  }

  const summary =
    DROPDOWN_BLURBS[ctx.modelId] ?? `Generate with ${modelName(ctx.modelId, "images")}.`;
  let fit: ModelGuidanceResult["fit"] = "good";
  let suggestion: ModelGuidanceResult["suggestion"];

  if (ctx.refImageCount >= 4 && (ctx.modelId === "nano-banana-2-lite" || ctx.modelId === "google-nano-banana")) {
    const target = ctx.refImageCount >= 6 ? "nano-banana-pro" : "nano-banana-2";
    fit = "mismatch";
    suggestion = {
      modelId: target,
      label: modelName(target, "images"),
      reason: `${ctx.refImageCount} refs — ${modelName(target, "images")} handles more.`,
    };
  } else if (
    !ctx.hasRefImages &&
    (ctx.modelId === "nano-banana-pro" || ctx.modelId === "nano-banana-2")
  ) {
    fit = "ok";
    suggestion = {
      modelId: "nano-banana-2-lite",
      label: modelName("nano-banana-2-lite", "images"),
      reason: "No refs — Lite is faster for text-only.",
    };
  }

  if (suggestion?.modelId === ctx.modelId) {
    suggestion = undefined;
    fit = "good";
  }

  const scenarioLabel = imageScenarioLabel(ctx);
  return {
    summary,
    fit,
    scenarioLabel,
    suggestion,
  };
}
