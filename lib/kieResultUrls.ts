import { isAllowedMediaUrl } from "@/lib/allowedMediaOrigins";

function pushUrl(urls: string[], value: unknown): void {
  if (typeof value === "string" && value) urls.push(value);
  else if (Array.isArray(value)) {
    value.filter((v) => typeof v === "string" && v).forEach((v) => urls.push(v));
  }
}

/** Extract allowlisted HTTPS result URLs from Kie callback / recordInfo payloads. */
export function extractAllowlistedKieUrls(
  resultJson?: unknown,
  extra?: Record<string, unknown>,
): string[] {
  const urls: string[] = [];

  let parsed: unknown = resultJson;
  if (typeof resultJson === "string" && resultJson.trim()) {
    try {
      parsed = JSON.parse(resultJson);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    pushUrl(urls, obj.resultUrls ?? obj.resultUrl ?? obj.videoUrl ?? obj.audioUrl ?? obj.imageUrl ?? obj.output);
    const info = obj.info as Record<string, unknown> | undefined;
    if (info) pushUrl(urls, info.resultUrls ?? info.originUrls);
  }
  if (extra) {
    pushUrl(urls, extra.videoUrl);
    pushUrl(urls, extra.audioUrl);
    pushUrl(urls, extra.output);
    if (extra.data && typeof extra.data === "object") {
      const data = extra.data as Record<string, unknown>;
      pushUrl(urls, data.videoUrl);
      pushUrl(urls, data.output);
    }
  }

  return [...new Set(urls.filter(isAllowedMediaUrl))];
}

/** Callback body shape (data may be nested). */
export function extractAllowlistedKieUrlsFromCallback(data: Record<string, unknown>): string[] {
  let urls = extractAllowlistedKieUrls(data.resultJson, data);
  if (urls.length === 0 && data.videoUrl) urls = extractAllowlistedKieUrls(undefined, { videoUrl: data.videoUrl });
  if (urls.length === 0 && (data.output ?? (data as { output?: unknown[] }).output?.[0])) {
    urls = extractAllowlistedKieUrls(undefined, { output: data.output });
  }
  return urls;
}
