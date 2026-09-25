import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { createClient } from "@/lib/supabase/server";
import { syncPendingKieJob } from "@/lib/kieJobSync";
import { veoDiagLog, veoDiagLookup } from "@/lib/veoDiag";

async function getAuthedUserId(req: NextRequest): Promise<string | null> {
  if (GUEST_MODE) return GUEST_USER_ID;

  // Cookie session first (EventSource / same-origin fetch cannot always send Bearer).
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

async function recoverJob(
  taskId: string,
  userId: string,
): Promise<"done" | "error" | "pending" | "not_found" | "forbidden"> {
  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    if (!gen) return "not_found";
    if (gen.user_id && gen.user_id !== userId) return "forbidden";
    if (gen.status === "done") {
      const result = gen.video_url
        ? { status: "done" as const, videoUrl: gen.video_url }
        : { status: "done" as const, imageUrl: gen.image_url ?? undefined, imageUrls: gen.image_urls ?? undefined };
      jobStore.set(taskId, result);
      return "done";
    }
    if (gen.status === "error") {
      jobStore.set(taskId, { status: "error", error: gen.error_msg ?? "Generation failed" });
      return "error";
    }
    return "pending";
  }

  const { data: gen } = await supabaseAdmin
    .from("generations")
    .select("status, video_url, image_url, image_urls, error_msg, user_id, generation_type")
    .eq("task_id", taskId)
    .single();

  if (!gen) return "not_found";
  if (gen.user_id !== userId) return "forbidden";

  if (gen.status === "done") {
    const result = gen.video_url
      ? { status: "done" as const, videoUrl: gen.video_url }
      : { status: "done" as const, imageUrl: gen.image_url, imageUrls: gen.image_urls };
    jobStore.set(taskId, result);
    return "done";
  }

  if (gen.status === "error") {
    jobStore.set(taskId, { status: "error", error: gen.error_msg ?? "Generation failed" });
    return "error";
  }

  return "pending";
}

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const userId = await getAuthedUserId(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Azure jobs have no Supabase record — keep local jobStore behaviour after auth.
  if (taskId.startsWith("azure-")) {
    const result = jobStore.get(taskId);
    return NextResponse.json(result ?? { status: "not_found" });
  }

  // Hidden talking pipeline — parent id is not a Kie taskId; do not poll recordInfo on it.
  if (taskId.startsWith("talk-")) {
    const recovered = await recoverJob(taskId, userId);
    if (recovered === "forbidden" || recovered === "not_found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (recovered === "done" || recovered === "error") {
      return NextResponse.json(jobStore.get(taskId)!);
    }
    const result = jobStore.get(taskId);
    return NextResponse.json(result ?? { status: "pending", phase: "creating-voice" });
  }

  const recovered = await recoverJob(taskId, userId);
  if (recovered === "forbidden" || recovered === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (recovered === "done" || recovered === "error") {
    const stored = jobStore.get(taskId)!;
    if (recovered === "error") {
      veoDiagLog("job-status-error", {
        taskId: taskId.slice(0, 16),
        error: (stored as { error?: string }).error?.slice(0, 200),
        remembered: veoDiagLookup(taskId) ?? null,
      });
    }
    return NextResponse.json(stored);
  }
  const result = jobStore.get(taskId);
  if (result && result.status !== "pending") {
    return NextResponse.json(result);
  }

  const synced = await syncPendingKieJob(taskId, userId);
  if (synced && synced.status !== "pending") {
    return NextResponse.json(synced);
  }

  return NextResponse.json(synced ?? { status: "pending", phase: "queued" });
}
