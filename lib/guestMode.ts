import type { NextRequest } from "next/server";

// Guest mode writes to local disk and skips auth, so it can never be allowed
// on Vercel — the flag is ignored there even if the project env sets it.
export const GUEST_MODE = process.env.GUEST_MODE === "true" && !process.env.VERCEL;
export const GUEST_USER_ID = "guest";

// Returns GUEST_USER_ID in guest mode, Supabase user ID otherwise.
export async function resolveUserId(req: NextRequest): Promise<string | null> {
  if (GUEST_MODE) return GUEST_USER_ID;
  const { supabaseAdmin } = await import("./supabase/admin");
  const auth  = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user?.id ?? null;
}
