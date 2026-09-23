import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { createClient } from "@/lib/supabase/server";
import { getKieTokenForUser } from "@/lib/getKieToken";
import { fetchKieRecordInfo, kieStateLower } from "@/lib/kieRecordInfo";
import { normalizeKiePhase } from "@/lib/genProgress";
import { resolveKieCallBackUrl } from "@/lib/kieCallback";
import { loadTalkingPipelineMeta } from "@/lib/talkingPipelineMeta";

async function getAuthedUserId(req: NextRequest): Promise<string | null> {
  if (GUEST_MODE) return GUEST_USER_ID;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.id) return user.id;
  } catch {
    // fall through
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user?.id ?? null;
}

type GenRow = {
  status: string;
  model?: string | null;
  progress_phase?: string | null;
  error_msg?: string | null;
  user_id?: string | null;
};

async function loadGeneration(taskId: string): Promise<GenRow | null> {
  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    if (!gen) return null;
    return {
      status: gen.status,
      model: (gen as { model?: string | null }).model,
      progress_phase: gen.progress_phase,
      error_msg: gen.error_msg,
      user_id: gen.user_id,
    };
  }
  const { data } = await supabaseAdmin
    .from("generations")
    .select("status, model, progress_phase, error_msg, user_id")
    .eq("task_id", taskId)
    .single();
  return data ?? null;
}

/** Compare HeliosGen DB phase vs live Kie recordInfo (auth + own jobs only). */
export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const userId = await getAuthedUserId(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gen = await loadGeneration(taskId);
  if (!gen) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (gen.user_id && gen.user_id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pipelineMeta = taskId.startsWith("talk-") ? await loadTalkingPipelineMeta(taskId) : null;
  const kiePollTaskId = pipelineMeta?.activeKieTaskId ?? (taskId.startsWith("talk-") ? null : taskId);

  const apiKey = await getKieTokenForUser(userId);
  let kie: Record<string, unknown> | null = null;
  if (apiKey && kiePollTaskId) {
    const record = await fetchKieRecordInfo(kiePollTaskId, apiKey);
    if (record.ok) {
      const state = kieStateLower(record.data);
      kie = {
        taskId: kiePollTaskId,
        state,
        normalizedPhase: normalizeKiePhase(state),
        failMsg: record.data.failMsg ?? record.data.error,
        hasResultJson: !!record.data.resultJson,
      };
    } else {
      kie = { taskId: kiePollTaskId, fetchError: record };
    }
  }

  return NextResponse.json({
    taskId,
    helios: {
      status: gen.status,
      progress_phase: gen.progress_phase ?? null,
      model: gen.model ?? null,
      error_msg: gen.error_msg ?? null,
      pipeline_meta: pipelineMeta,
    },
    kie,
    ops: {
      callbackUrlConfigured: !!resolveKieCallBackUrl(),
      hint: gen.progress_phase === "queued" && kie && (kie as { state?: string }).state === "waiting"
        ? "Time is in Kie queue — normal under load."
        : undefined,
    },
  });
}
