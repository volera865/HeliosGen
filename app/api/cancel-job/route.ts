import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { jobEvents } from "@/lib/jobEvents";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { createClient } from "@/lib/supabase/server";
import { persistGenerationError } from "@/lib/generationSettle";
import { STOPPED_BY_USER_MSG } from "@/lib/stopJob";

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

export async function POST(req: NextRequest) {
  const userId = await getAuthedUserId(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { taskId?: string };
  try {
    body = await req.json() as { taskId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const taskId = body.taskId?.trim();
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  if (GUEST_MODE) {
    const gen = guestDb.recoverJob(taskId);
    if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (gen.user_id && gen.user_id !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (gen.status !== "pending") {
      return NextResponse.json({ ok: true, alreadyTerminal: true });
    }
    await persistGenerationError(taskId, STOPPED_BY_USER_MSG);
    guestDb.updateGeneration(taskId, { progress_phase: null });
    return NextResponse.json({ ok: true });
  }

  const { data: gen, error: loadErr } = await supabaseAdmin
    .from("generations")
    .select("status, user_id")
    .eq("task_id", taskId)
    .single();

  if (loadErr || !gen) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (gen.user_id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (gen.status !== "pending") {
    return NextResponse.json({ ok: true, alreadyTerminal: true });
  }

  await persistGenerationError(taskId, STOPPED_BY_USER_MSG);
  await supabaseAdmin
    .from("generations")
    .update({ progress_phase: null })
    .eq("task_id", taskId);

  return NextResponse.json({ ok: true });
}
