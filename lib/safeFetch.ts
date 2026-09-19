import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped IPv6
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  // Unique local fc00::/7
  if (v.startsWith("fc") || v.startsWith("fd")) return true;
  // Link-local fe80::/10
  if (v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) return true;

  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

async function assertSafeHostname(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("URL host resolves to a private address");
    return;
  }
  const results = await lookup(host, { all: true, verbatim: true });
  if (!results.length) throw new Error("URL host could not be resolved");
  for (const r of results) {
    if (isPrivateIp(r.address)) throw new Error("URL host resolves to a private address");
  }
}

export type SafeFetchResult = {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
};

/**
 * Fetch a remote HTTPS URL with SSRF protections:
 * https-only, private/loopback/link-local DNS rejection, no unsafe redirects,
 * timeout, and a hard size cap.
 */
export async function safeFetchUrl(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? 5;

  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error("Invalid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("Only https URLs are supported");
    }
    await assertSafeHostname(parsed.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HeliosGen/1.0)" },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Redirect without Location");
      current = new URL(loc, current).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch URL: ${res.status} ${res.statusText}`);
    }

    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > maxBytes) {
      throw new Error(`File exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
    }

    const contentType = (res.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0].trim().toLowerCase();

    const reader = res.body?.getReader();
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        throw new Error(`File exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
      }
      return { buffer: buf, contentType, finalUrl: current };
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { reader.cancel(); } catch { /* ignore */ }
        throw new Error(`File exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB limit`);
      }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks), contentType, finalUrl: current };
  }

  throw new Error("Too many redirects");
}
