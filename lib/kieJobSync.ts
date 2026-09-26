import { jobStore, type JobResult } from "@/lib/jobStore";
import { getKieTokenForUser } from "@/lib/getKieToken";
import { normalizeKiePhase } from "@/lib/genProgress";
import { extractAllowlistedKieUrls } from "@/lib/kieResultUrls";
import {
  persistGenerationError,
  settleEarlyThenMirror,
} from "@/lib/generationSettle";
import { persistProgressPhase } from "@/lib/progressPhase";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { mapKieFailMessage } from "@/lib/veoFailMessage";
import {
  isGoogleVideoModel,
  isVeoOutageFailure,
  recordVeoFailure,
  recordVeoSuccess,
} from "@/lib/veoOutage";
import { veoDiagFail, veoDiagLog } from "@/lib/veoDiag";
import { veoUrlLog } from "@/lib/veoClientPayload";

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
  progress_phase?: string | null;
  reference_image_urls?: string[] | null;
  model?: string | null;
};

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
  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    if (!gen) return null;
    return {
      ...gen,
      reference_image_urls: (gen as { reference_image_urls?: string[] }).reference_image_urls ?? null,
    };
  }
  const { data } = await supabaseAdmin
    .from("generations")
    .select("status, video_url, image_url, image_urls, error_msg, user_id, generation_type, progress_phase, reference_image_urls, model")
    .eq("task_id", taskId)
    .single();
  return data ?? null;
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
    const nImageUrls = Array.isArray(gen.reference_image_urls) ? gen.reference_image_urls.length : 0;
    const hadFrames = nImageUrls > 0;
    const failCode = data.failCode ?? data.errorCode ?? null;
    const errorMessage = data.errorMessage ?? null;
    const error = mapKieFailMessage({
      code: typeof failCode === "number" ? failCode : undefined,
      failMsg: String(data.failMsg ?? data.error ?? errorMessage ?? "Generation failed"),
      hadFrames,
      nImageUrls,
    });
    if (isGoogleVideoModel((gen as { model?: string }).model)) {
      if (isVeoOutageFailure({
        code: failCode as number | string | null,
        failMsg: data.failMsg === undefined ? null : String(data.failMsg),
      })) {
        recordVeoFailure(String(data.failMsg ?? errorMessage ?? ""));
      }
    }
    veoDiagFail(taskId, {
      path: "kie-sync",
      state,
      failMsg: data.failMsg,
      failCode,
      errorCode: data.errorCode ?? null,
      errorMessage,
      successFlag: data.successFlag ?? null,
      fallbackFlag: data.fallbackFlag ?? null,
      operationType: data.operationType ?? null,
      dataKeys: data && typeof data === "object" ? Object.keys(data) : [],
      hadFrames,
      nRefs: gen.reference_image_urls?.length ?? 0,
      refHosts: (gen.reference_image_urls ?? []).map((u) => veoUrlLog(u)),
      model: (gen as { model?: string }).model,
      mapped: error,
    });
    return persistGenerationError(taskId, error);
  }
  if (state !== "success") {
    const phase = normalizeKiePhase(state);
    void persistProgressPhase(taskId, phase);
    return { status: "pending", phase };
  }

  if (isGoogleVideoModel((gen as { model?: string }).model)) recordVeoSuccess();

  jobStore.set(taskId, { status: "pending", phase: "saving" });
  void persistProgressPhase(taskId, "saving");

  const kieUrls = extractAllowlistedKieUrls(data.resultJson, data);
  if (kieUrls.length === 0) {
    console.error("[kie-sync] success but no allowlisted URL for", taskId);
    return persistGenerationError(taskId, "Result URL missing — retry or contact support");
  }

  const isVideo = gen.generation_type === "video"
    || (jobStore.get(taskId)?.status === "pending" && (jobStore.get(taskId) as { type?: string }).type === "video");

  return settleEarlyThenMirror(taskId, isVideo, kieUrls, (work) => {
    void work();
  });
}

/** Pull a pending Kie job into local storage if it has already finished. */
export function syncPendingKieJob(taskId: string, userId: string): Promise<JobResult | null> {
  const existing = inflight.get(taskId);
  if (existing) return existing;
  const pending = syncOnce(taskId, userId).finally(() => inflight.delete(taskId));
  inflight.set(taskId, pending);
  return pending;
}
