import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import type { TalkingVoice } from "@/lib/talkingPrompt";

export type TalkingActiveStep = "tts" | "avatar" | "seedance";

export type TalkingPipelineMeta = {
  voice: TalkingVoice;
  topic: string;
  aspectRatio: string;
  duration: number;
  faceUrl?: string;
  audioUrl?: string;
  activeKieTaskId?: string;
  activeStep?: TalkingActiveStep;
};

export async function loadTalkingPipelineMeta(taskId: string): Promise<TalkingPipelineMeta | null> {
  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    const meta = gen?.pipeline_meta;
    return meta && typeof meta === "object" ? (meta as TalkingPipelineMeta) : null;
  }
  const { data } = await supabaseAdmin
    .from("generations")
    .select("pipeline_meta")
    .eq("task_id", taskId)
    .single();
  const meta = data?.pipeline_meta;
  if (!meta || typeof meta !== "object") return null;
  return meta as TalkingPipelineMeta;
}

export async function saveTalkingPipelineMeta(taskId: string, meta: TalkingPipelineMeta): Promise<void> {
  if (GUEST_MODE) {
    guestDb.updateGeneration(taskId, { pipeline_meta: meta });
    return;
  }
  const { error } = await supabaseAdmin
    .from("generations")
    .update({ pipeline_meta: meta })
    .eq("task_id", taskId);
  if (error) console.error("[talking-meta]", taskId.slice(0, 12), error.message);
}

/** Find talk-* parent waiting on a Kie sub-task (callback or poll). */
export async function findTalkingParentByKieTaskId(kieTaskId: string): Promise<string | null> {
  if (GUEST_MODE) {
    return guestDb.findTalkingParentByKieTaskId(kieTaskId);
  }
  const { data, error } = await supabaseAdmin
    .from("generations")
    .select("task_id")
    .eq("pipeline_meta->>activeKieTaskId", kieTaskId)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[talking-meta] parent lookup", error.message);
    return null;
  }
  return data?.task_id ?? null;
}
