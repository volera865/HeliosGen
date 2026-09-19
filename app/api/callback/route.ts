import { NextRequest, NextResponse, after } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";

// Same host allowlist used by app/api/download/route.ts for kie.ai / R2 assets.
const ALLOWED_ORIGINS = [
  process.env.R2_PUBLIC_URL ?? "",
  "https://cdn.kie.ai",
  "https://api.kie.ai",
  "https://replicate.delivery",
  "https://pbxt.replicate.delivery",
].filter(Boolean).map((o) => o.replace(/\/$/, ""));

function isAllowedResultUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return ALLOWED_ORIGINS.some((origin) => url.startsWith(origin));
  } catch {
    return false;
  }
}

function extractUrls(resultJson?: string): string[] {
  if (!resultJson) return [];
  try {
    const parsed = JSON.parse(resultJson);
    const urls = parsed.resultUrls ?? parsed.resultUrl;
    if (Array.isArray(urls)) return urls.filter(Boolean);
    if (urls) return [urls];
    return [];
  } catch {
    return [];
  }
}

function settle(taskId: string, result: Parameters<typeof jobStore.set>[1]) {
  jobStore.set(taskId, result);
  jobEvents.emit(`job:${taskId}`, result);
}

async function loadGeneration(taskId: string): Promise<{ status: string } | null> {
  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    return gen ? { status: gen.status } : null;
  }
  const { data: gen } = await supabaseAdmin
    .from("generations")
    .select("status")
    .eq("task_id", taskId)
    .single();
  return gen ? { status: gen.status } : null;
}

function isTerminal(status: string): boolean {
  return status === "done" || status === "error";
}

// The R2 mirror runs in `after()` and needs the full window to copy large
// videos before the platform kills the invocation.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const body = await req.json();

  const data   = body.data ?? body;
  const taskId = data.taskId ?? data.id ?? body.taskId ?? body.id;
  const state  = String(data.state ?? data.status ?? "").toLowerCase();

  // Log only identifiers — never the full callback body (may contain URLs/keys).
  console.log("[callback] taskId:", taskId, "state:", state);

  if (!taskId) {
    return NextResponse.json({ received: true });
  }

  const gen = await loadGeneration(taskId);
  if (!gen || isTerminal(gen.status)) {
    // Unknown or already settled — ack without mutating anything.
    return NextResponse.json({ received: true });
  }

  // Treat a non-200 top-level code as a hard error (e.g. Veo 500 responses that
  // carry no state/status field but do carry body.code and body.msg).
  if (body.code !== undefined && body.code !== 200) {
    const error = data.failMsg ?? body.msg ?? "Generation failed";
    settle(taskId, { status: "error", error });
    if (GUEST_MODE) {
      guestDb.updateGeneration(taskId, { status: "error", error_msg: error });
    } else {
      supabaseAdmin
        .from("generations")
        .update({ status: "error", error_msg: error })
        .eq("task_id", taskId)
        .then(({ error: e }) => {
          if (e) console.error("[callback] supabase error update failed:", e.message);
        });
    }
    return NextResponse.json({ received: true });
  }

  if (state === "success") {
    let kieUrls = extractUrls(data.resultJson);
    if (kieUrls.length === 0 && data.videoUrl) {
      kieUrls = [data.videoUrl];
    }
    if (kieUrls.length === 0 && (data.output?.[0] ?? data.output)) {
      kieUrls.push(data.output?.[0] ?? data.output);
    }
    // Accept only https URLs on the download allowlist; ignore others.
    kieUrls = kieUrls.filter((u) => typeof u === "string" && isAllowedResultUrl(u));
    if (kieUrls.length > 0) {
      const existing = jobStore.get(taskId);
      const isVideo  = existing?.status === "pending" && (existing as { type?: string }).type === "video";
      const folder   = isVideo ? "videos" : "images";

      const mirrorAll = () => Promise.all(kieUrls.map((u) => mirrorToR2(u, folder)));

      after(async () => {
        let storedUrls: string[];
        try {
          storedUrls = await mirrorAll();
        } catch (firstErr) {
          console.error("[callback] storage upload failed, retrying once:", (firstErr as Error).message);
          try {
            storedUrls = await mirrorAll();
          } catch (err) {
            console.error("[callback] storage upload failed, using source URLs:", (err as Error).message);
            storedUrls = kieUrls;
          }
        }

        if (isVideo) {
          settle(taskId, { status: "done", videoUrl: storedUrls[0] });
          if (GUEST_MODE) {
            guestDb.updateGeneration(taskId, { status: "done", video_url: storedUrls[0] });
          } else {
            const { error: e } = await supabaseAdmin
              .from("generations")
              .update({ status: "done", video_url: storedUrls[0] })
              .eq("task_id", taskId);
            if (e) console.error("[callback] supabase update error:", e.message);
          }
        } else {
          settle(taskId, { status: "done", imageUrl: storedUrls[0], imageUrls: storedUrls });
          if (GUEST_MODE) {
            guestDb.updateGeneration(taskId, { status: "done", image_url: storedUrls[0], image_urls: storedUrls });
          } else {
            const { error: e } = await supabaseAdmin
              .from("generations")
              .update({ status: "done", image_url: storedUrls[0], image_urls: storedUrls })
              .eq("task_id", taskId);
            if (e) console.error("[callback] supabase update error:", e.message);
          }
        }
      });
    } else {
      console.log("[callback] success but no allowed URL found");
    }
  } else if (state === "fail" || state === "failed" || state === "error") {
    const error = data.failMsg ?? data.error ?? body.msg ?? "Generation failed";
    settle(taskId, { status: "error", error });

    if (GUEST_MODE) {
      guestDb.updateGeneration(taskId, { status: "error", error_msg: error });
    } else {
      supabaseAdmin
        .from("generations")
        .update({ status: "error", error_msg: error })
        .eq("task_id", taskId)
        .then(({ error: e }) => {
          if (e) console.error("[callback] supabase error update failed:", e.message);
        });
    }
  } else {
    console.log("[callback] intermediate state, ignoring:", state);
  }

  return NextResponse.json({ received: true });
}
