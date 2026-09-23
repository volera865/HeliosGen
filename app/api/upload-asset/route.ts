/**
 * POST /api/upload-asset
 *
 * Unified raw-binary upload for images and videos.
 * Body  : raw file bytes
 * Headers:
 *   Content-Type  : MIME type of the file (image/jpeg, video/mp4, …)
 *   Authorization : Bearer <supabase-token>  (required)
 *
 * Flow:
 *   1. Require auth
 *   2. Read body as Buffer (MIME allowlist + size cap)
 *   3. Deduplication happens inside uploadBuffer (lib/r2.ts)
 *   4. Record in user_uploads
 *   5. Return CDN URL
 */
import { NextRequest, NextResponse } from "next/server";
import { uploadBuffer } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import {
  PROXY_UPLOAD_MAX_BYTES,
  UPLOAD_ALLOWED_MIMES,
} from "@/lib/uploadLimits";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const mimeType = (req.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0].trim().toLowerCase();

    if (!UPLOAD_ALLOWED_MIMES.has(mimeType)) {
      return NextResponse.json({ error: `Unsupported media type: ${mimeType}` }, { status: 415 });
    }

    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > PROXY_UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: "File exceeds 4 MB limit" }, { status: 413 });
    }

    const bytes  = await req.arrayBuffer();
    const buffer = Buffer.from(bytes);

    if (buffer.byteLength > PROXY_UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: "File exceeds 4 MB limit" }, { status: 413 });
    }

    const folder  = mimeType.startsWith("video/") || mimeType.startsWith("audio/") ? "references" : "uploads";
    const cdnUrl  = await uploadBuffer(buffer, mimeType, folder);

    if (GUEST_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: cdnUrl, mime_type: mimeType, source: "user_upload" });
    } else {
      supabaseAdmin.from("user_uploads").insert({
        user_id:   userId,
        r2_url:    cdnUrl,
        mime_type: mimeType,
        source:    "user_upload",
      }).then(({ error }) => {
        if (error) console.error("[upload-asset] db insert error:", error.message);
      });
    }

    return NextResponse.json({ cdnUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
