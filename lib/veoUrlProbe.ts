/** Best-effort public reachability check for Veo imageUrls (kie must fetch them). */

export type VeoProbeResult = {
  url: string;
  host: string;
  ok: boolean;
  status?: number;
  method?: string;
  error?: string;
};

export async function probeImageUrlsDetailed(urls: string[]): Promise<VeoProbeResult[]> {
  const out: VeoProbeResult[] = [];
  for (const url of urls) {
    out.push(await probeUrlDetailed(url));
  }
  return out;
}

export async function assertPublicImageUrls(urls: string[]): Promise<string | null> {
  const results = await probeImageUrlsDetailed(urls);
  const bad = results.find((r) => !r.ok);
  if (!bad) return null;
  return `Frame URL not publicly reachable — re-upload and try again (${bad.host}${bad.status ? ` HTTP ${bad.status}` : ""}${bad.error ? ` ${bad.error}` : ""})`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

async function probeUrlDetailed(url: string): Promise<VeoProbeResult> {
  const host = safeHost(url);
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { url, host, ok: false, error: "bad-protocol" };
    }
  } catch {
    return { url, host, ok: false, error: "invalid-url" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    let method = "HEAD";
    let res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      method = "GET-range";
      res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
      });
    }
    const ok = res.ok || res.status === 206;
    return { url, host, ok, status: res.status, method };
  } catch (e) {
    return { url, host, ok: false, error: e instanceof Error ? e.name : "fetch-failed" };
  } finally {
    clearTimeout(timer);
  }
}
