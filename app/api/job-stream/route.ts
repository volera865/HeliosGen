import { NextRequest } from "next/server";
import { jobStore, type JobResult } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { createClient } from "@/lib/supabase/server";
import { syncPendingKieJob } from "@/lib/kieJobSync";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
};

const TIMEOUT_MS = 12 * 60 * 1000; // 12 min hard cap
const DB_POLL_MS = 4_000;          // fallback for callbacks handled elsewhere

function immediate(payload: JobResult): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: SSE_HEADERS });
}

async function getAuthedUserId(req: NextRequest): Promise<string | null> {
  if (GUEST_MODE) return GUEST_USER_ID;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.id) return user.id;
  } catch {
    // fall through to Bearer
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user?.id ?? null;
}

/** Terminal result, null if still pending, or ownership/missing markers. */
async function recoverJob(
  taskId: string,
  userId: string,
): Promise<JobResult | null | "forbidden" | "not_found"> {
  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    if (!gen) return "not_found";
    if (gen.user_id && gen.user_id !== userId) return "forbidden";
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

  const { data: gen } = await supabaseAdmin
    .from("generations")
    .select("status, video_url, image_url, image_urls, error_msg, user_id, generation_type")
    .eq("task_id", taskId)
    .single();

  if (!gen) return "not_found";
  if (gen.user_id !== userId) return "forbidden";

  if (gen.status === "done") {
    return gen.video_url
      ? { status: "done", videoUrl: gen.video_url }
      : { status: "done", imageUrl: gen.image_url, imageUrls: gen.image_urls };
  }
  if (gen.status === "error") {
    return { status: "error", error: gen.error_msg ?? "Generation failed" };
  }
  return null;
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) return new Response("taskId required", { status: 400 });

  const userId = await getAuthedUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const isAzure = taskId.startsWith("azure-");
  const isTalkPipeline = taskId.startsWith("talk-");

  if (isAzure) {
    const existing = jobStore.get(taskId);
    if (existing && existing.status !== "pending") return immediate(existing);
    if (!existing) return immediate({ status: "error", error: "Job not found" });
    // pending azure — stream via in-process events only (no DB poll)
  } else {
    const recovered = await recoverJob(taskId, userId);
    if (recovered === "forbidden" || recovered === "not_found") {
      return new Response("Not found", { status: 404 });
    }
    if (recovered) {
      jobStore.set(taskId, recovered);
      return immediate(recovered);
    }

    const existing = jobStore.get(taskId);
    if (existing && existing.status !== "pending") return immediate(existing);

    if (!isTalkPipeline) {
      const synced = await syncPendingKieJob(taskId, userId);
      if (synced && synced.status !== "pending") return immediate(synced);
    }
    // Pending owned job — open SSE + Kie poll below
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(dbPoll);
        clearTimeout(timeout);
        controller.close();
      };

      const send = (payload: JobResult) => {
        if (closed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
        close();
      };

      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(": ping\n\n"));
      }, 25_000);

      let polling = false;
      const pollKie = () => {
        if (closed || polling || isAzure) return;
        polling = true;
        recoverJob(taskId, userId)
          .then(async (settled) => {
            if (settled === "forbidden" || settled === "not_found" || closed) return;
            if (!settled) {
              if (isTalkPipeline) return;
              const synced = await syncPendingKieJob(taskId, userId);
              if (!synced || synced.status === "pending" || closed) return;
              send(synced);
              return;
            }
            jobStore.set(taskId, settled);
            send(settled);
          })
          .catch(() => { /* transient DB / Kie error — try again next tick */ })
          .finally(() => { polling = false; });
      };
      const dbPoll = setInterval(pollKie, DB_POLL_MS);
      pollKie();

      const timeout = setTimeout(() => {
        send({ status: "error", error: "Generation timed out" });
      }, TIMEOUT_MS);

      jobEvents.once(`job:${taskId}`, send);

      req.signal.addEventListener("abort", () => {
        jobEvents.off(`job:${taskId}`, send);
        close();
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
