import { NextRequest, NextResponse } from "next/server";
import { uploadDataUrl, mirrorToR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";

/**
 * POST { dataUrl: string, folder?: string, mimeType?: string }
 *   → uploads a base64 data URL or remote URL to R2
 *   → records the upload in user_uploads if authenticated
 *   → returns { cdnUrl: string }
 */

const ALLOWED_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a",
]);

/** Decoded data-URL payload limit (~3 MB); Vercel request bodies are ~4.5 MB. */
const DATA_URL_MAX_DECODED = 3 * 1024 * 1024;

function mimeFromDataUrl(dataUrl: string): string | null {
  const m = /^data:([^;,]+)/i.exec(dataUrl);
  return m ? m[1].trim().toLowerCase() : null;
}

function decodedDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const meta = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
  }
  try {
    return decodeURIComponent(payload).length;
  } catch {
    return payload.length;
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { dataUrl, folder = "uploads", mimeType } = await req.json() as {
      dataUrl:   string;
      folder?:   string;
      mimeType?: string;
    };

    if (!dataUrl) {
      return NextResponse.json({ error: "dataUrl is required" }, { status: 400 });
    }

    let resolvedMime = (mimeType ?? "").toLowerCase().split(";")[0].trim();
    if (dataUrl.startsWith("data:")) {
      resolvedMime = mimeFromDataUrl(dataUrl) ?? resolvedMime;
      if (!ALLOWED_MIMES.has(resolvedMime)) {
        return NextResponse.json({ error: `Unsupported media type: ${resolvedMime || "unknown"}` }, { status: 415 });
      }
      const size = decodedDataUrlBytes(dataUrl);
      if (size > DATA_URL_MAX_DECODED) {
        return NextResponse.json({ error: "Data URL exceeds 3 MB decoded limit" }, { status: 413 });
      }
    } else if (dataUrl.startsWith("http")) {
      // Remote mirrors must declare an allowlisted MIME (clients always pass one).
      if (!resolvedMime || !ALLOWED_MIMES.has(resolvedMime)) {
        return NextResponse.json({ error: `Unsupported media type: ${resolvedMime || "unknown"}` }, { status: 415 });
      }
    } else {
      return NextResponse.json({ error: "dataUrl must be a data: or http: URL" }, { status: 400 });
    }

    let cdnUrl: string;
    if (dataUrl.startsWith("data:")) {
      cdnUrl = await uploadDataUrl(dataUrl, folder);
    } else {
      cdnUrl = await mirrorToR2(dataUrl, folder);
    }

    if (GUEST_MODE) {
      guestDb.insertUpload({ user_id: userId, r2_url: cdnUrl, mime_type: resolvedMime || mimeType || null, source: "user_upload" });
    } else {
      supabaseAdmin.from("user_uploads").insert({
        user_id:   userId,
        r2_url:    cdnUrl,
        mime_type: resolvedMime || mimeType || null,
        source:    "user_upload",
      }).then(({ error }) => {
        if (error) console.error("[upload-to-r2] db insert error:", error.message);
      });
    }

    return NextResponse.json({ cdnUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
