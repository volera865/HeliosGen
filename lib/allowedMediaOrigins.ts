/**
 * Shared allowlist for proxied / mirrored generation result URLs.
 * Used by callback settlement and /api/download.
 */

const STATIC_ORIGINS = [
  "https://cdn.kie.ai",
  "https://api.kie.ai",
  "https://tempfile.aiquickdraw.com",
  "https://replicate.delivery",
  "https://pbxt.replicate.delivery",
];

const HOST_SUFFIXES = [
  ".kie.ai",
  ".aiquickdraw.com",
  ".replicate.delivery",
  ".r2.dev",
];

function originPrefixes(): string[] {
  const r2 = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");
  return [...STATIC_ORIGINS, ...(r2 ? [r2] : [])].map((o) => o.replace(/\/$/, ""));
}

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "kie.ai" || host === "aiquickdraw.com" || host === "replicate.delivery") return true;
  return HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** True when `url` is https on an allowlisted media / CDN host. */
export function isAllowedMediaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (originPrefixes().some((origin) => url.startsWith(origin))) return true;
    return hostAllowed(u.hostname);
  } catch {
    return false;
  }
}
