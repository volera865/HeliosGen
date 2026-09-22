export type TalkingVoice = "woman" | "man" | "boy";

export const TALKING_VOICES: { id: TalkingVoice; label: string }[] = [
  { id: "woman", label: "Woman" },
  { id: "man", label: "Man" },
  { id: "boy", label: "Boy" },
];

export type TalkingRoute = "generate" | "lip-sync" | "audio-only";

export const TALKING_GENERATE_MODEL = "seedance-2-5";
export const TALKING_LIPSYNC_MODEL = "kling-ai-avatar-standard";
/** ElevenLabs on Kie is currently 500ing every job; Gemini Flash TTS is the working path. */
export const TALKING_TTS_MODEL = "google/gemini-3-1-flash-tts";

const GEMINI_VOICES: Record<TalkingVoice, string> = {
  woman: "Kore",
  man: "Fenrir",
  boy: "Puck",
};

export function geminiVoiceFor(voice: TalkingVoice): string {
  return GEMINI_VOICES[voice];
}

/** @deprecated kept for older imports — Gemini is the live TTS path */
export function elevenLabsVoiceFor(voice: TalkingVoice): string {
  return geminiVoiceFor(voice);
}

const TTS_HARD_MAX = 800;

export function sanitizeTtsText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const CAMERA_LINE = /^(show|transition to|use a |slowly |push the camera|make the |the atmosphere|add |cut to)/i;
const QUOTED = /"([^"]{2,})"|“([^”]{2,})”|«([^»]{2,})»/g;

function quotedLines(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(QUOTED)) {
    const line = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\s+/g, " ").trim();
    if (line) found.push(line);
  }
  return found;
}

function capSpoken(text: string, durationSec: number): string {
  const max = Math.min(TTS_HARD_MAX, Math.max(160, Math.round((Number(durationSec) || 5) * 18)));
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  return (cut > 80 ? slice.slice(0, cut + 1) : slice).trim();
}

/** Prefer "quoted" dialogue. Otherwise strip shot-list lines and cap to the clip. */
export function spokenTextForDuration(raw: string, durationSec: number): string {
  const cleaned = sanitizeTtsText(raw);
  const quotes = quotedLines(cleaned);
  if (quotes.length) return capSpoken(quotes.join(" "), durationSec);
  const lines = cleaned.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const spoken = lines.filter((l) => !/^scene\s+\d+/i.test(l) && !CAMERA_LINE.test(l));
  const text = (spoken.length ? spoken : lines).join(" ").replace(/\s+/g, " ").trim();
  return capSpoken(text, durationSec);
}

export function talkingPipelineHelper(): string {
  return "Words in quotation marks are spoken. The rest is picture direction. A real song needs uploaded audio. Do not use photos of famous people.";
}

const VOICE_LINES: Record<TalkingVoice, string> = {
  woman: "The speaker is an adult woman with a natural female voice.",
  man: "The speaker is an adult man with a natural male voice.",
  boy: "The speaker is a young boy with a youthful male voice.",
};

export function parseTalkingVoice(value: unknown): TalkingVoice {
  if (value === "man" || value === "boy" || value === "woman") return value;
  return "woman";
}

export function resolveTalkingRoute(opts: { hasFace: boolean; hasAudio: boolean }): TalkingRoute {
  if (opts.hasAudio && opts.hasFace) return "lip-sync";
  if (opts.hasAudio) return "audio-only";
  return "generate";
}

export function talkingModelForRoute(route: TalkingRoute): string {
  return route === "lip-sync" ? TALKING_LIPSYNC_MODEL : TALKING_GENERATE_MODEL;
}

export function wrapTalkingPrompt(
  prompt: string,
  opts: { route: TalkingRoute; voice: TalkingVoice; hasFace: boolean },
): string {
  const topic = prompt.trim();
  if (opts.route === "lip-sync") {
    return topic || "Lip-sync the face to the audio with natural head motion and accurate mouth movement.";
  }
  if (opts.route === "audio-only") {
    return topic
      ? `A person performs to this audio track, facing the camera with natural motion. ${topic}`
      : "A person performs to this audio track, facing the camera with natural motion.";
  }
  const faceLine = opts.hasFace
    ? "Animate the person in the reference image. Natural head motion and clear lip-sync."
    : "Photorealistic talking-head close-up, facing the camera.";
  const topicLine = topic
    ? `They speak clearly to camera with accurate lip-sync. Topic: ${topic}`
    : "They speak clearly to camera with accurate lip-sync.";
  return `${VOICE_LINES[opts.voice]} ${faceLine} ${topicLine}`;
}

export function talkingRouteLabel(route: TalkingRoute): string {
  if (route === "lip-sync") return "Lip-sync";
  if (route === "audio-only") return "Audio only";
  return "Generate voice";
}

export function talkingVoiceStatus(route: TalkingRoute, voice: TalkingVoice): string {
  if (route !== "generate") return "Voice from your audio";
  const labels: Record<TalkingVoice, string> = {
    woman: "Woman voice",
    man: "Man voice",
    boy: "Boy voice",
  };
  return labels[voice];
}

export function isSeedanceTalkingFamily(id?: string): boolean {
  return !!id && id.startsWith("seedance-2") && id !== "seedance-2-5-edit";
}
