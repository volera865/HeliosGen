import { jobStore, type JobResult } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { getKieTokenForUser } from "@/lib/getKieToken";
import { normalizeKiePhase } from "@/lib/genProgress";

const RECORD_INFO = "https://api.kie.ai/api/v1/jobs/recordInfo";

const inflight = new Map<string, Promise<JobResult | null>>();

type GenerationRow = {
  status: string;
  video_url?: string | null;
  image_url?: string | null;
  image_urls?: string[] | null;
  error_msg?: string | null;
  user_id?: string | null;
  generation_type?: string | null;
};

function isPublicHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return false;
    return true;
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
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    push(obj.resultUrls ?? obj.resultUrl ?? obj.videoUrl ?? obj.imageUrl ?? obj.output);
  }
  if (extra) {
    push(extra.videoUrl);
    push(extra.output);
  }
  return [...new Set(urls.filter(isPublicHttpsUrl))];
}

function toJobResult(gen: GenerationRow): JobResult | null {
  if (gen.status === "done") {
    return gen.video_url
      ? { status: "done", videoUrl: gen.video_url }
      : { status: "done", imageUrl: gen.image_url ?? undefined, imageUrls: gen.image_urls ?? undefined };
  }
  if (gen.status === "error") {
    return { status: "error", error: gen.error_msg ?? "Generation failed" };
  }
  return null;
}

async function loadGeneration(taskId: string): Promise<GenerationRow | null> {
  if (GUEST_MODE) return guestDb.recoverJob(taskId);
  const { data } = await supabaseAdmin
    .from("generations")
    .select("status, video_url, image_url, image_urls, error_msg, user_id, generation_type")
    .eq("task_id", taskId)
    .single();
  return data ?? null;
}

function settle(taskId: string, result: JobResult): JobResult {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
  return result;
}

async function persistDone(taskId: string, isVideo: boolean, storedUrls: string[]): Promise<JobResult> {
  const result: JobResult = isVideo
    ? { status: "done", videoUrl: storedUrls[0] }
    : { status: "done", imageUrl: storedUrls[0], imageUrls: storedUrls };

  if (GUEST_MODE) {
    guestDb.updateGeneration(
      taskId,
      isVideo
        ? { status: "done", video_url: storedUrls[0] }
        : { status: "done", image_url: storedUrls[0], image_urls: storedUrls },
    );
  } else {
    const { error } = await supabaseAdmin
      .from("generations")
      .update(
        isVideo
          ? { status: "done", video_url: storedUrls[0] }
          : { status: "done", image_url: storedUrls[0], image_urls: storedUrls },
      )
      .eq("task_id", taskId);
    if (error) console.error("[kie-sync] supabase update failed:", error.message);
  }

  return settle(taskId, result);
}

async function persistError(taskId: string, error: string): Promise<JobResult> {
  const result: JobResult = { status: "error", error };
  if (GUEST_MODE) {
    guestDb.updateGeneration(taskId, { status: "error", error_msg: error });
  } else {
    const { error: e } = await supabaseAdmin
      .from("generations")
      .update({ status: "error", error_msg: error })
      .eq("task_id", taskId);
    if (e) console.error("[kie-sync] supabase error update failed:", e.message);
  }
  return settle(taskId, result);
}

async function fetchKieRecord(taskId: string, apiKey: string): Promise<Record<string, unknown> | null> {
  const url = `${RECORD_INFO}?taskId=${encodeURIComponent(taskId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) {
    console.error("[kie-sync] recordInfo HTTP", res.status);
    return null;
  }
  const body = await res.json() as { code?: number; msg?: string; data?: Record<string, unknown> };
  if (body.code !== undefined && body.code !== 200) {
    console.error("[kie-sync] recordInfo API", body.code, body.msg);
    return null;
  }
  return body.data ?? null;
}

async function syncOnce(taskId: string, userId: string): Promise<JobResult | null> {
  const gen = await loadGeneration(taskId);
  if (!gen) return null;
  if (gen.user_id && gen.user_id !== userId) return null;

  const already = toJobResult(gen);
  if (already) {
    jobStore.set(taskId, already);
    return already;
  }

  const apiKey = await getKieTokenForUser(userId);
  if (!apiKey) return { status: "pending", phase: "queued" };

  const data = await fetchKieRecord(taskId, apiKey);
  if (!data) return { status: "pending", phase: "queued" };

  const state = String(data.state ?? data.status ?? "").toLowerCase();
  if (state && state !== "success") {
    console.log("[kie-sync]", taskId.slice(0, 8), "state=", state);
  }
  if (state === "fail" || state === "failed" || state === "error") {
    const error = String(data.failMsg ?? data.error ?? "Generation failed");
    console.error("[kie-sync]", taskId.slice(0, 8), "fail:", error);
    return persistError(taskId, error);
  }
  if (state !== "success") return { status: "pending", phase: normalizeKiePhase(state) };

  jobStore.set(taskId, { status: "pending", phase: "saving" });

  const kieUrls = extractUrls(data.resultJson, data);
  if (kieUrls.length === 0) {
    console.error("[kie-sync] success but no result URL for", taskId);
    return { status: "pending", phase: "saving" };
  }

  const isVideo = gen.generation_type === "video"
    || (jobStore.get(taskId)?.status === "pending" && (jobStore.get(taskId) as { type?: string }).type === "video");
  const folder = isVideo ? "videos" : "images";

  let storedUrls: string[];
  try {
    storedUrls = await Promise.all(kieUrls.map((u) => mirrorToR2(u, folder)));
  } catch (err) {
    console.error("[kie-sync] mirror failed, using source URLs:", (err as Error).message);
    storedUrls = kieUrls;
  }

  return persistDone(taskId, isVideo, storedUrls);
}

/** Pull a pending Kie job into local storage if it has already finished. */
export function syncPendingKieJob(taskId: string, userId: string): Promise<JobResult | null> {
  const existing = inflight.get(taskId);
  if (existing) return existing;
  const pending = syncOnce(taskId, userId).finally(() => inflight.delete(taskId));
  inflight.set(taskId, pending);
  return pending;
}
