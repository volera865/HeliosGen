import { jobStore } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { muxNarrationOntoVideo } from "@/lib/muxNarration";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import {
  TALKING_GENERATE_MODEL,
  TALKING_TTS_MODEL,
  geminiVoiceFor,
  spokenTextForDuration,
  type TalkingVoice,
} from "@/lib/talkingPrompt";
import { VIDEO_MODELS } from "@/lib/modelConfig";

const KIE_CREATE = "https://api.kie.ai/api/v1/jobs/createTask";
const RECORD_INFO = "https://api.kie.ai/api/v1/jobs/recordInfo";
const AVATAR_MODEL = "kling/ai-avatar-standard";
const TRANSIENT_KIE = /internal error|try again later|temporarily unavailable|timeout/i;

function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function extractUrls(resultJson?: unknown, extra?: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value) urls.push(value);
    else if (Array.isArray(value)) value.filter((v) => typeof v === "string" && v).forEach((v) => urls.push(v));
  };
  let parsed: unknown = resultJson;
  if (typeof resultJson === "string" && resultJson.trim()) {
    try { parsed = JSON.parse(resultJson); } catch { parsed = null; }
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    push(obj.resultUrls ?? obj.resultUrl ?? obj.videoUrl ?? obj.audioUrl ?? obj.imageUrl ?? obj.output);
  }
  if (extra) {
    push(extra.videoUrl);
    push(extra.audioUrl);
    push(extra.output);
  }
  return [...new Set(urls.filter(isPublicHttpsUrl))];
}

function pickAudioUrl(urls: string[]): string | undefined {
  return urls.find((u) => /\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/i.test(u)) ?? urls[0];
}

function pickVideoUrl(urls: string[]): string | undefined {
  return urls.find((u) => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(u)) ?? urls[0];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isTransientKie(msg: string): boolean {
  return TRANSIENT_KIE.test(msg);
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = value.length > 160 ? `${value.slice(0, 160)}…` : value;
    else out[key] = value;
  }
  return out;
}

async function createKieTask(
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(KIE_CREATE, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  const text = await res.text();
  let body: { code?: number; msg?: string; data?: { taskId?: string; id?: string } };
  try {
    body = JSON.parse(text) as { code?: number; msg?: string; data?: { taskId?: string; id?: string } };
  } catch {
    throw new Error(text.slice(0, 300) || `Kie HTTP ${res.status}`);
  }
  if (!res.ok || body.code !== 200) {
    throw new Error(body.msg || text.slice(0, 300) || `Kie HTTP ${res.status}`);
  }
  const id = body.data?.taskId || body.data?.id;
  if (!id) throw new Error("No taskId returned");
  return id;
}

async function waitForKieUrls(
  apiKey: string,
  taskId: string,
  timeoutMs: number,
): Promise<string[]> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${RECORD_INFO}?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    if (res.ok) {
      const body = await res.json() as { code?: number; data?: Record<string, unknown> };
      const data = body.data ?? {};
      const state = String(data.state ?? data.status ?? "").toLowerCase();
      if (state === "fail" || state === "failed" || state === "error") {
        throw new Error(String(data.failMsg ?? data.error ?? "Generation failed"));
      }
      if (state === "success") {
        const urls = extractUrls(data.resultJson, data);
        if (urls.length === 0) throw new Error("No result URL from Kie");
        return urls;
      }
    }
    await sleep(2500);
  }
  throw new Error("Timed out waiting for Kie");
}

async function runKieStep(
  parentId: string,
  step: string,
  apiKey: string,
  model: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<string[]> {
  const attempt = async () => {
    console.log("[talking-pipeline]", parentId, step, "create", model, JSON.stringify(summarizeInput(input)));
    const taskId = await createKieTask(apiKey, model, input);
    console.log("[talking-pipeline]", parentId, step, "task", taskId);
    const urls = await waitForKieUrls(apiKey, taskId, timeoutMs);
    console.log("[talking-pipeline]", parentId, step, "done", urls.length, "url(s)");
    return urls;
  };
  try {
    return await attempt();
  } catch (e) {
    const msg = errMessage(e);
    if (!isTransientKie(msg)) throw new Error(`${step}: ${msg}`);
    console.warn("[talking-pipeline]", parentId, step, "retry", msg);
    await sleep(1500);
    try {
      return await attempt();
    } catch (retryErr) {
      throw new Error(`${step}: ${errMessage(retryErr)}`);
    }
  }
}

function setPhase(parentId: string, userId: string | undefined, phase: string) {
  jobStore.set(parentId, { status: "pending", type: "video", userId, phase });
}

async function persistError(parentId: string, error: string) {
  const result = { status: "error" as const, error };
  if (GUEST_MODE) guestDb.updateGeneration(parentId, { status: "error", error_msg: error });
  else {
    const { error: e } = await supabaseAdmin
      .from("generations")
      .update({ status: "error", error_msg: error })
      .eq("task_id", parentId);
    if (e) console.error("[talking-pipeline] supabase error update:", e.message);
  }
  jobStore.set(parentId, result);
  jobEvents.emit(`job:${parentId}`, result);
}

async function persistDone(parentId: string, videoUrl: string) {
  const result = { status: "done" as const, videoUrl };
  if (GUEST_MODE) guestDb.updateGeneration(parentId, { status: "done", video_url: videoUrl });
  else {
    const { error } = await supabaseAdmin
      .from("generations")
      .update({ status: "done", video_url: videoUrl })
      .eq("task_id", parentId);
    if (error) console.error("[talking-pipeline] supabase done update:", error.message);
  }
  jobStore.set(parentId, result);
  jobEvents.emit(`job:${parentId}`, result);
}

export async function runTalkingPipeline(opts: {
  parentId: string;
  apiKey: string;
  userId?: string;
  topic: string;
  voice: TalkingVoice;
  faceUrl?: string;
  audioUrl?: string;
  aspectRatio: string;
  duration: number;
}): Promise<void> {
  const { parentId, apiKey, userId, topic, voice, aspectRatio, duration } = opts;
  let audioUrl = opts.audioUrl;
  const faceUrl = opts.faceUrl;

  try {
    const spoken = spokenTextForDuration(topic, duration);
    console.log(
      "[talking-pipeline]",
      parentId,
      "start",
      JSON.stringify({
        voice,
        voiceName: geminiVoiceFor(voice),
        ttsModel: TALKING_TTS_MODEL,
        hasFace: !!faceUrl,
        hasAudio: !!audioUrl,
        topicChars: spoken.length,
      }),
    );

    if (!audioUrl) {
      if (!spoken) throw new Error("A topic is required to create a voice.");
      setPhase(parentId, userId, "creating-voice");
      const ttsUrls = await runKieStep(parentId, "tts", apiKey, TALKING_TTS_MODEL, {
        temperature: 1,
        sample_context: "Clear spoken narration for a short talking-head video.",
        speakers: [{
          speaker_id: "Speaker 1",
          voice_name: geminiVoiceFor(voice),
          accent: "American (Gen)",
          style: "Newscaster",
          pace: "Natural",
        }],
        dialogue_turns: [{ speaker_id: "Speaker 1", text: spoken }],
      }, 3 * 60 * 1000);
      audioUrl = pickAudioUrl(ttsUrls);
    }

    if (!audioUrl) throw new Error("tts: Voice creation returned no audio.");

    if (faceUrl) {
      setPhase(parentId, userId, "lip-sync");
      const videoUrls = await runKieStep(parentId, "avatar", apiKey, AVATAR_MODEL, {
        image_url: faceUrl,
        audio_url: audioUrl,
        prompt: spoken || "Lip-sync the face to the audio with natural head motion and accurate mouth movement.",
      }, 10 * 60 * 1000);
      const videoUrl = pickVideoUrl(videoUrls);
      if (!videoUrl) throw new Error("avatar: No video URL from Kie");
      setPhase(parentId, userId, "saving");
      let stored = videoUrl;
      try { stored = await mirrorToR2(videoUrl, "videos"); } catch { /* keep source */ }
      await persistDone(parentId, stored);
      return;
    }

    setPhase(parentId, userId, "generating");
    const seedance = VIDEO_MODELS.find((m) => m.id === TALKING_GENERATE_MODEL);
    const clamped = Math.max(4, Math.min(30, Number(duration) || 5));
    const visualPrompt = topic.trim() || spoken;
    const videoUrls = await runKieStep(parentId, "seedance", apiKey, seedance?.apiId ?? "bytedance/seedance-2-5", {
      prompt: visualPrompt
        ? `${visualPrompt}\n\nCinematic picture only. Do not invent dialogue. A separate narrator track will be added.`
        : "Cinematic documentary footage of a person facing the camera with natural motion. Silent picture; narration is added later.",
      reference_audio_urls: [audioUrl],
      generate_audio: false,
      aspect_ratio: aspectRatio || "9:16",
      duration: clamped,
      resolution: seedance?.defaultResolution ?? "720p",
    }, 10 * 60 * 1000);
    const videoUrl = pickVideoUrl(videoUrls);
    if (!videoUrl) throw new Error("seedance: No video URL from Kie");
    setPhase(parentId, userId, "saving");
    let stored = videoUrl;
    try {
      stored = await muxNarrationOntoVideo(videoUrl, audioUrl);
      console.log("[talking-pipeline]", parentId, "muxed narration onto video");
    } catch (muxErr) {
      console.warn("[talking-pipeline]", parentId, "mux failed, keeping silent clip", errMessage(muxErr));
      try { stored = await mirrorToR2(videoUrl, "videos"); } catch { /* keep source */ }
    }
    await persistDone(parentId, stored);
  } catch (e) {
    const msg = errMessage(e);
    console.error("[talking-pipeline]", parentId, "fail", msg);
    await persistError(parentId, msg);
  }
}

export function talkingParentId(): string {
  return `talk-${crypto.randomUUID()}`;
}
