import { NextRequest, NextResponse } from "next/server";
import { uploadBuffer } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";

export const maxDuration = 60;

const ALLOWED_MIMES = new Set([
  "video/mp4", "video/webm", "video/quicktime",
]);

/** Align with Vercel ~4.5 MB request body limit. */
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const mimeType = (req.headers.get("content-type") || "video/mp4")
      .split(";")[0].trim().toLowerCase();
    if (!ALLOWED_MIMES.has(mimeType)) {
      return NextResponse.json({ error: `Unsupported media type: ${mimeType}` }, { status: 415 });
    }

    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BYTES) {
      return NextResponse.json({ error: "File exceeds 4 MB limit" }, { status: 413 });
    }

    const bytes  = await req.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (buffer.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "File exceeds 4 MB limit" }, { status: 413 });
    }

    const cdnUrl = await uploadBuffer(buffer, mimeType, "references");

    if (GUEST_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: cdnUrl, mime_type: mimeType, source: "user_upload" });
    } else {
      supabaseAdmin.from("user_uploads").insert({
        user_id:   userId,
        r2_url:    cdnUrl,
        mime_type: mimeType,
        source:    "user_upload",
      }).then(({ error }) => {
        if (error) console.error("[upload-video] db insert error:", error.message);
      });
    }

    return NextResponse.json({ cdnUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
