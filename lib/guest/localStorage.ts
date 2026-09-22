import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID, createHash } from "crypto";
import https from "node:https";
import http  from "node:http";
import { lookupAssetHash, storeAssetHash } from "./db";
import { stripMetadata } from "../mediaMetadata";
import { resolvePublicAssetOrigin } from "../kieCallback";
import { toKieFetchableUrl } from "../kieFileUpload";
import { extFromContentType, urlMatchesContentType } from "../mediaType";

const GENERATED_DIR = join(process.cwd(), "public", "generated");

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function uploadBuffer(buffer: Buffer, contentType: string, folder: string): Promise<string> {
  buffer = await stripMetadata(buffer, contentType);
  const hash   = hashBuffer(buffer);
  const cached = lookupAssetHash(hash);
  if (cached && urlMatchesContentType(cached, contentType)) return cached;

  await mkdir(join(GENERATED_DIR, folder), { recursive: true });
  const filename = `${randomUUID()}.${extFromContentType(contentType)}`;
  await writeFile(join(GENERATED_DIR, folder, filename), buffer);
  const url = `/generated/${folder}/${filename}`;

  storeAssetHash(hash, url, contentType, buffer.byteLength);
  return url;
}

function fetchToBuffer(url: string, maxRedirects = 5): Promise<{ buf: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error("Too many redirects"));
    const u   = new URL(url);
    const mod = u.protocol === "https:" ? https : (http as unknown as typeof https);
    mod.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchToBuffer(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks: Buffer[] = [];
      res.on("data",  (c: Buffer) => chunks.push(c));
      res.on("end",   () => resolve({ buf: Buffer.concat(chunks), contentType: res.headers["content-type"] ?? "image/jpeg" }));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export async function mirrorToStorage(url: string, folder: string): Promise<string> {
  const { buf, contentType } = await fetchToBuffer(url);
  return uploadBuffer(buf, contentType, folder);
}

export async function uploadDataUrl(dataUrl: string, folder: string): Promise<string> {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error("Not a valid data URL");
  return uploadBuffer(Buffer.from(m[2], "base64"), m[1], folder);
}

/** Kie.ai fetches this over the internet, so a bare "/generated/..." path
 *  won't resolve. Prefer a live public origin; otherwise upload to Kie's
 *  file API. Never prefix a dead tunnel (loca.lt / placeholder). */
export async function ensureStorage(url: string, folder: string): Promise<string> {
  const origin = resolvePublicAssetOrigin();
  if (origin && url.startsWith(`${origin}/generated/`)) return url;
  if (url.startsWith("https://") && !url.includes(".loca.lt/") && url.indexOf("/generated/") === -1) {
    return url;
  }

  const stored = url.startsWith("data:")
    ? await uploadDataUrl(url, folder)
    : url.includes("/generated/")
    ? (url.slice(url.indexOf("/generated/")))
    : await mirrorToStorage(url, folder);

  if (origin) return `${origin}${stored}`;
  return toKieFetchableUrl(stored);
}
