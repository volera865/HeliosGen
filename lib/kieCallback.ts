/**
 * Kie can complete jobs via webhook OR by us polling recordInfo.
 * Only attach a callback URL when it is a real public https origin.
 * Dead tunnels (loca.lt, placeholders) keep jobs stuck in "waiting".
 */
export function resolveKieCallBackUrl(raw = process.env.CALLBACK_BASE_URL): string | undefined {
  const base = raw?.trim();
  if (!base) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host.endsWith(".loca.lt") ||
    host.endsWith(".example") ||
    host === "example.com" ||
    host.endsWith(".example.com") ||
    host.includes("placeholder")
  ) {
    return undefined;
  }
  return `${base.replace(/\/$/, "")}/api/callback`;
}

/** Public origin for serving /generated assets, or undefined if the tunnel is not usable. */
export function resolvePublicAssetOrigin(raw = process.env.CALLBACK_BASE_URL): string | undefined {
  const callback = resolveKieCallBackUrl(raw);
  return callback ? callback.replace(/\/api\/callback$/, "") : undefined;
}
