/**
 * Browser helper: upload a File to storage and return the CDN URL.
 *
 * - Guest mode → POST /api/upload-asset (local disk proxy, ≤4 MB)
 * - Cloud mode → presign → PUT to R2 → /api/upload-complete (≤100 MB)
 */

import {
  DIRECT_UPLOAD_MAX_BYTES,
  PROXY_UPLOAD_MAX_BYTES,
} from "@/lib/uploadLimits";

function guestModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_GUEST_MODE === "true";
}

export class UploadAssetError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "UploadAssetError";
    this.status = status;
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadViaProxy(file: File, token: string): Promise<string> {
  if (file.size > PROXY_UPLOAD_MAX_BYTES) {
    throw new UploadAssetError("File exceeds 4 MB limit", 413);
  }
  const res = await fetch("/api/upload-asset", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      Authorization: `Bearer ${token}`,
    },
    body: file,
  });
  const data = (await res.json()) as { cdnUrl?: string; error?: string };
  if (!res.ok || !data.cdnUrl) {
    throw new UploadAssetError(data.error ?? "Upload failed", res.status);
  }
  return data.cdnUrl;
}

async function uploadDirectToR2(file: File, token: string): Promise<string> {
  if (file.size > DIRECT_UPLOAD_MAX_BYTES) {
    throw new UploadAssetError("File exceeds 100 MB limit", 413);
  }

  const contentType = file.type || "application/octet-stream";
  const bytes = await file.arrayBuffer();
  let sha256: string | undefined;
  try {
    sha256 = await sha256Hex(bytes);
  } catch {
    /* optional */
  }

  if (sha256) {
    try {
      const lk = await fetch(`/api/lookup-asset?hash=${sha256}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (lk.ok) {
        const { cdnUrl } = (await lk.json()) as { cdnUrl: string | null };
        if (cdnUrl) return cdnUrl;
      }
    } catch {
      /* fall through */
    }
  }

  const presignRes = await fetch("/api/upload-presign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      contentType,
      byteSize: file.size,
    }),
  });
  const presign = (await presignRes.json()) as {
    uploadUrl?: string;
    cdnUrl?: string;
    headers?: { "Content-Type"?: string };
    error?: string;
    useProxy?: boolean;
  };

  if (presignRes.status === 501 || presign.useProxy) {
    return uploadViaProxy(file, token);
  }
  if (!presignRes.ok || !presign.uploadUrl || !presign.cdnUrl) {
    throw new UploadAssetError(presign.error ?? "Presign failed", presignRes.status);
  }

  const putHeaders: Record<string, string> = {
    "Content-Type":
      presign.headers?.["Content-Type"] ?? contentType,
  };
  const putRes = await fetch(presign.uploadUrl, {
    method: "PUT",
    headers: putHeaders,
    body: bytes,
  });
  if (!putRes.ok) {
    throw new UploadAssetError(
      `R2 upload failed (${putRes.status}). Check bucket CORS allows PUT from this origin.`,
      putRes.status,
    );
  }

  const completeRes = await fetch("/api/upload-complete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      cdnUrl: presign.cdnUrl,
      contentType,
      byteSize: file.size,
      sha256,
    }),
  });
  const complete = (await completeRes.json()) as {
    cdnUrl?: string;
    error?: string;
  };
  if (!completeRes.ok || !complete.cdnUrl) {
    throw new UploadAssetError(
      complete.error ?? "Upload complete failed",
      completeRes.status,
    );
  }
  return complete.cdnUrl;
}

/** Upload a File; returns the public CDN URL. */
export async function uploadAssetFile(
  file: File,
  token: string,
): Promise<string> {
  if (guestModeEnabled()) {
    return uploadViaProxy(file, token);
  }
  return uploadDirectToR2(file, token);
}
