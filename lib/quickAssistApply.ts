/** Structured output from Quick Assist (JSON schema in systemPrompt). */

export type QuickAssistPage = "image" | "video";

export interface QuickAssistSettings {
  page: QuickAssistPage;
  model: string;
  aspectRatio?: string;
  /** Video only */
  resolution?: string;
  duration?: number;
  talkingMode?: boolean;
  sound?: boolean;
}

export interface QuickAssistApplyPayload {
  prompt: string;
  settings: QuickAssistSettings;
}

/**
 * Parse an assistant message as `{ prompt, settings }`.
 * Accepts optional markdown fences. Returns null on any failure (plain-text fallback).
 */
export function parseQuickAssistResponse(raw: string): QuickAssistApplyPayload | null {
  let text = raw.trim();
  if (!text) return null;

  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) text = fence[1].trim();

  // Tolerate leading/trailing prose around a single JSON object
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.prompt !== "string") return null;
  if (!obj.settings || typeof obj.settings !== "object") return null;

  const s = obj.settings as Record<string, unknown>;
  if (s.page !== "image" && s.page !== "video") return null;
  if (typeof s.model !== "string" || !s.model.trim()) return null;

  const settings: QuickAssistSettings = {
    page: s.page,
    model: s.model.trim(),
  };

  if (typeof s.aspectRatio === "string" && s.aspectRatio.trim()) {
    settings.aspectRatio = s.aspectRatio.trim();
  }

  if (settings.page === "video") {
    if (typeof s.resolution === "string" && s.resolution.trim()) {
      settings.resolution = s.resolution.trim();
    }
    if (typeof s.duration === "number" && Number.isFinite(s.duration)) {
      settings.duration = s.duration;
    }
    if (typeof s.talkingMode === "boolean") settings.talkingMode = s.talkingMode;
    if (typeof s.sound === "boolean") settings.sound = s.sound;
  }

  return { prompt: obj.prompt, settings };
}
