import { jobStore, type JobResult } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { isStoppedErrorMessage, STOPPED_BY_USER_MSG } from "@/lib/stopJob";

const mirrorInFlight = new Set<string>();

export { STOPPED_BY_USER_MSG };

/** True when the user stopped this job — do not overwrite with done. */
export async function isGenerationStopped(taskId: string): Promise<boolean> {
  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    return gen?.status === "error" && isStoppedErrorMessage(gen.error_msg);
  }
  const { data } = await supabaseAdmin
    .from("generations")
    .select("status, error_msg")
    .eq("task_id", taskId)
    .single();
  return data?.status === "error" && isStoppedErrorMessage(data.error_msg);
}

function emitSettle(taskId: string, result: JobResult): JobResult {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
  return result;
}

export async function persistGenerationDone(
  taskId: string,
  isVideo: boolean,
  urls: string[],
): Promise<JobResult> {
  if (await isGenerationStopped(taskId)) {
    console.log("[generation-settle] skip done — user stopped", taskId.slice(0, 12));
    return { status: "error", error: STOPPED_BY_USER_MSG };
  }
  const result: JobResult = isVideo
    ? { status: "done", videoUrl: urls[0] }
    : { status: "done", imageUrl: urls[0], imageUrls: urls };

  if (GUEST_MODE) {
    guestDb.updateGeneration(
      taskId,
      isVideo
        ? { status: "done", video_url: urls[0] }
        : { status: "done", image_url: urls[0], image_urls: urls },
    );
  } else {
    const { error } = await supabaseAdmin
      .from("generations")
      .update(
        isVideo
          ? { status: "done", video_url: urls[0] }
          : { status: "done", image_url: urls[0], image_urls: urls },
      )
      .eq("task_id", taskId);
    if (error) console.error("[generation-settle] supabase update failed:", error.message);
  }

  return emitSettle(taskId, result);
}

export async function persistGenerationError(taskId: string, error: string): Promise<JobResult> {
  const result: JobResult = { status: "error", error };
  if (GUEST_MODE) {
    guestDb.updateGeneration(taskId, { status: "error", error_msg: error });
  } else {
    const { error: e } = await supabaseAdmin
      .from("generations")
      .update({ status: "error", error_msg: error })
      .eq("task_id", taskId);
    if (e) console.error("[generation-settle] supabase error update failed:", e.message);
  }
  return emitSettle(taskId, result);
}

async function patchStoredUrls(taskId: string, isVideo: boolean, storedUrls: string[]): Promise<void> {
  if (await isGenerationStopped(taskId)) return;
  if (GUEST_MODE) {
    guestDb.updateGeneration(
      taskId,
      isVideo
        ? { status: "done", video_url: storedUrls[0] }
        : { status: "done", image_url: storedUrls[0], image_urls: storedUrls },
    );
  } else {
    await supabaseAdmin
      .from("generations")
      .update(
        isVideo
          ? { status: "done", video_url: storedUrls[0] }
          : { status: "done", image_url: storedUrls[0], image_urls: storedUrls },
      )
      .eq("task_id", taskId);
  }
  emitSettle(
    taskId,
    isVideo
      ? { status: "done", videoUrl: storedUrls[0] }
      : { status: "done", imageUrl: storedUrls[0], imageUrls: storedUrls },
  );
}

/** Mirror Kie URLs to R2 in the background; patch DB when R2 URL differs. */
export async function mirrorKieUrlsInBackground(
  taskId: string,
  isVideo: boolean,
  kieUrls: string[],
): Promise<void> {
  if (mirrorInFlight.has(taskId) || kieUrls.length === 0) return;
  mirrorInFlight.add(taskId);
  try {
    const folder = isVideo ? "videos" : "images";
    let storedUrls: string[];
    try {
      storedUrls = await Promise.all(kieUrls.map((u) => mirrorToR2(u, folder)));
    } catch (firstErr) {
      console.error("[generation-settle] mirror failed, retry once:", (firstErr as Error).message);
      try {
        storedUrls = await Promise.all(kieUrls.map((u) => mirrorToR2(u, folder)));
      } catch {
        return;
      }
    }
    const r2Base = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
    if (r2Base && storedUrls[0]?.startsWith(r2Base) && storedUrls[0] !== kieUrls[0]) {
      await patchStoredUrls(taskId, isVideo, storedUrls);
    }
  } finally {
    mirrorInFlight.delete(taskId);
  }
}

/** Settle immediately with Kie CDN URLs; schedule mirror separately. */
export async function settleEarlyThenMirror(
  taskId: string,
  isVideo: boolean,
  kieUrls: string[],
  schedule: (work: () => Promise<void>) => void,
): Promise<JobResult> {
  const result = await persistGenerationDone(taskId, isVideo, kieUrls);
  schedule(() => mirrorKieUrlsInBackground(taskId, isVideo, kieUrls));
  return result;
}
