/**
 * POST /api/upload-presign
 *
 * Issues a short-lived R2 PUT URL so the browser can upload directly
 * (bypasses Vercel's ~4.5 MB body limit). Guest mode must use /api/upload-asset.
 *
 * Body: { contentType, byteSize, folder? }
 * Response: { uploadUrl, cdnUrl, key, headers }
 */
import { NextRequest, NextResponse } from "next/server";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import { folderForUploadMime, presignPutObject } from "@/lib/r2";
import {
  DIRECT_UPLOAD_MAX_BYTES,
  UPLOAD_ALLOWED_MIMES,
} from "@/lib/uploadLimits";

export async function POST(req: NextRequest) {
  try {
    if (GUEST_MODE) {
      return NextResponse.json(
        {
          error: "Direct R2 upload unavailable in guest mode; use /api/upload-asset",
          useProxy: true,
        },
        { status: 501 },
      );
    }

    const userId = await resolveUserId(req);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      contentType?: string;
      byteSize?: number;
      folder?: string;
    };

    const contentType = (body.contentType ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!contentType || !UPLOAD_ALLOWED_MIMES.has(contentType)) {
      return NextResponse.json(
        { error: `Unsupported media type: ${contentType || "(missing)"}` },
        { status: 415 },
      );
    }

    const byteSize = Number(body.byteSize ?? 0);
    if (!Number.isFinite(byteSize) || byteSize <= 0) {
      return NextResponse.json({ error: "byteSize required" }, { status: 400 });
    }
    if (byteSize > DIRECT_UPLOAD_MAX_BYTES) {
      return NextResponse.json(
        { error: "File exceeds 100 MB limit" },
        { status: 413 },
      );
    }

    const folder =
      typeof body.folder === "string" && body.folder.trim()
        ? body.folder.trim()
        : folderForUploadMime(contentType);

    if (folder !== "uploads" && folder !== "references") {
      return NextResponse.json({ error: "Invalid folder" }, { status: 400 });
    }

    const signed = await presignPutObject({ contentType, folder });
    return NextResponse.json(signed);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
