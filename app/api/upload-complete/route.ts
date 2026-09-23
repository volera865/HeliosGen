/**
 * POST /api/upload-complete
 *
 * Records a browser→R2 upload in user_uploads (and optional asset_cache hash).
 * Body: { cdnUrl, contentType, byteSize?, sha256? }
 */
import { NextRequest, NextResponse } from "next/server";
import { storeAssetHash } from "@/lib/assetCache";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  DIRECT_UPLOAD_MAX_BYTES,
  UPLOAD_ALLOWED_MIMES,
} from "@/lib/uploadLimits";

export async function POST(req: NextRequest) {
  try {
    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      cdnUrl?: string;
      contentType?: string;
      byteSize?: number;
      sha256?: string;
    };

    const cdnUrl = typeof body.cdnUrl === "string" ? body.cdnUrl.trim() : "";
    const contentType = (body.contentType ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (!cdnUrl || !contentType) {
      return NextResponse.json(
        { error: "cdnUrl and contentType required" },
        { status: 400 },
      );
    }

    if (!UPLOAD_ALLOWED_MIMES.has(contentType)) {
      return NextResponse.json(
        { error: `Unsupported media type: ${contentType}` },
        { status: 415 },
      );
    }

    const publicBase = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
    if (!publicBase || !cdnUrl.startsWith(`${publicBase}/`)) {
      return NextResponse.json({ error: "cdnUrl not under R2_PUBLIC_URL" }, { status: 400 });
    }

    const byteSize =
      typeof body.byteSize === "number" && Number.isFinite(body.byteSize)
        ? body.byteSize
        : undefined;
    if (byteSize !== undefined && byteSize > DIRECT_UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: "File exceeds 100 MB limit" }, { status: 413 });
    }

    if (GUEST_MODE) {
      guestDb.insertUpload({
        user_id: userId,
        r2_url: cdnUrl,
        mime_type: contentType,
        source: "user_upload",
      });
    } else {
      const { error } = await supabaseAdmin.from("user_uploads").insert({
        user_id: userId,
        r2_url: cdnUrl,
        mime_type: contentType,
        source: "user_upload",
      });
      if (error) console.error("[upload-complete] db insert error:", error.message);
    }

    const sha256 =
      typeof body.sha256 === "string" && /^[a-f0-9]{64}$/i.test(body.sha256)
        ? body.sha256.toLowerCase()
        : null;
    if (sha256 && byteSize !== undefined && byteSize > 0) {
      try {
        await storeAssetHash(sha256, cdnUrl, contentType, byteSize);
      } catch (err) {
        console.error("[upload-complete] storeAssetHash:", err);
      }
    }

    return NextResponse.json({ cdnUrl });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
