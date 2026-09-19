/**
 * POST /api/fetch-url
 *
 * Fetches a remote image/video URL server-side and uploads it to R2.
 * Body: { url: string }
 * Returns: { cdnUrl: string; mediaType: "image" | "video" }
 */
import { NextRequest, NextResponse } from "next/server";
import { uploadBuffer } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { safeFetchUrl } from "@/lib/safeFetch";

export const maxDuration = 60;

const ALLOWED_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a",
]);

const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { url } = await req.json() as { url?: string };
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }

    let fetched;
    try {
      fetched = await safeFetchUrl(url, { maxBytes: MAX_BYTES, timeoutMs: 30_000 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /exceeds/i.test(msg) ? 413 : 400;
      return NextResponse.json({ error: msg }, { status });
    }

    const mimeType = fetched.contentType;
    if (!ALLOWED_MIMES.has(mimeType)) {
      return NextResponse.json({ error: `Unsupported media type: ${mimeType}` }, { status: 415 });
    }

    const isImage = mimeType.startsWith("image/");
    const isVideo = mimeType.startsWith("video/");
    const folder = isVideo || mimeType.startsWith("audio/") ? "references" : "uploads";
    const cdnUrl = await uploadBuffer(fetched.buffer, mimeType, folder);
    const mediaType: "image" | "video" = isImage ? "image" : "video";

    if (GUEST_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: cdnUrl, mime_type: mimeType, source: "user_upload" });
    } else {
      supabaseAdmin.from("user_uploads").insert({
        user_id:   userId,
        r2_url:    cdnUrl,
        mime_type: mimeType,
        source:    "user_upload",
      }).then(({ error }) => {
        if (error) console.error("[fetch-url] db insert error:", error.message);
      });
    }

    return NextResponse.json({ cdnUrl, mediaType });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
