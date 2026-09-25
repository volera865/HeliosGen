import { readFile } from "fs/promises";
import { join } from "path";
import { getKieApiToken } from "@/lib/guest/db";
import { sniffMedia } from "@/lib/mediaType";

const KIE_UPLOAD = "https://kieai.redpandaai.co/api/file-stream-upload";
const GENERATED_DIR = join(process.cwd(), "public", "generated");
const cache = new Map<string, string>();

function localGeneratedPath(url: string): string | null {
  const marker = "/generated/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const rel = url.slice(idx + marker.length).split("?")[0];
  if (!rel || rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) return null;
  return join(GENERATED_DIR, rel);
}

async function uploadBufferToKie(buffer: Buffer, fileName: string, mime: string): Promise<string> {
  const apiKey = getKieApiToken();
  if (!apiKey) throw new Error("No Kie.ai API key configured. Add one in Settings.");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mime }), fileName);
  form.append("uploadPath", "heliosgen");
  form.append("fileName", fileName);

  const res = await fetch(KIE_UPLOAD, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const body = await res.json() as {
    code?: number;
    msg?: string;
    data?: { downloadUrl?: string; fileUrl?: string };
  };
  if (!res.ok || (body.code !== undefined && body.code !== 200)) {
    throw new Error(body.msg ?? `Kie file upload failed (${res.status})`);
  }
  const publicUrl = body.data?.downloadUrl ?? body.data?.fileUrl;
  if (!publicUrl) throw new Error("Kie file upload returned no URL");
  return publicUrl;
}

/** Make a local /generated/... asset fetchable by Kie without a public tunnel. */
export async function toKieFetchableUrl(url: string): Promise<string> {
  const diskPath = localGeneratedPath(url);
  if (!diskPath) return url;

  const buffer = await readFile(diskPath);
  const originalName = diskPath.split("/").pop() ?? `asset-${Date.now()}`;
  const sniffed = sniffMedia(buffer, originalName);
  const uploadName = `${originalName.replace(/\.[^.]+$/, "")}.${sniffed.ext}`;
  const cacheKey = `${diskPath}::${sniffed.mime}`;
  const sniffedCached = cache.get(cacheKey);
  if (sniffedCached) return sniffedCached;

  const publicUrl = await uploadBufferToKie(buffer, uploadName, sniffed.mime);
  cache.set(cacheKey, publicUrl);
  return publicUrl;
}

function isAlreadyKieHosted(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("redpandaai.co") || host.includes("kie.ai") || host === "cdn.kie.ai";
  } catch {
    return false;
  }
}

async function fetchUrlToBuffer(url: string): Promise<{ buf: Buffer; mime: string; name: string }> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch frame (${res.status})`);
  const mime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  const name = url.split("/").pop()?.split("?")[0] || `frame-${Date.now()}.jpg`;
  return { buf, mime, name };
}

/**
 * Veo (and Google Flow behind kie) must fetch imageUrls themselves.
 * Guest `/generated/...` paths and third-party tempfiles (aiquickdraw) often
 * fail opaque Internal Error — re-host onto kie file CDN when needed.
 */
export async function ensureKieHostedImageUrl(url: string): Promise<string> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("Empty frame URL");

  // Local guest assets
  if (trimmed.includes("/generated/")) {
    const hosted = await toKieFetchableUrl(trimmed);
    if (!hosted.startsWith("https://")) {
      throw new Error("Could not publish local frame to kie CDN");
    }
    return hosted;
  }

  if (!trimmed.startsWith("https://")) {
    throw new Error("Frame URL must be https or a /generated/ path");
  }

  if (isAlreadyKieHosted(trimmed)) return trimmed;

  const cacheKey = `remote::${trimmed}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { buf, mime, name } = await fetchUrlToBuffer(trimmed);
  const sniffed = sniffMedia(buf, name);
  const uploadName = `${name.replace(/\.[^.]+$/, "") || "frame"}.${sniffed.ext}`;
  const publicUrl = await uploadBufferToKie(buf, uploadName, sniffed.mime || mime);
  cache.set(cacheKey, publicUrl);
  return publicUrl;
}
