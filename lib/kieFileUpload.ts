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
