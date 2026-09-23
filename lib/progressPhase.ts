import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";

/** Persist in-progress label for cross-instance polls and Realtime. */
export async function persistProgressPhase(taskId: string, phase: string): Promise<void> {
  if (GUEST_MODE) {
    guestDb.updateGeneration(taskId, { progress_phase: phase });
    return;
  }
  const { error } = await supabaseAdmin
    .from("generations")
    .update({ progress_phase: phase })
    .eq("task_id", taskId);
  if (error) console.error("[progress-phase]", taskId.slice(0, 12), error.message);
}
