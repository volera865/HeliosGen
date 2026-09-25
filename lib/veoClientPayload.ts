/**
 * Canonical Veo client payload for gallery + workflow.
 * Both UIs must send the same shape into POST /api/generate-video.
 */

export type VeoClientSource = "gallery" | "workflow";

export type VeoMode = "frames" | "references";

export type VeoGenerationType =
  | "TEXT_2_VIDEO"
  | "FIRST_AND_LAST_FRAMES_2_VIDEO"
  | "REFERENCE_2_VIDEO";

export interface BuildVeoGenerateBodyArgs {
  source: VeoClientSource;
  modelId: string;
  prompt: string;
  aspectRatio: string;
  resolution?: string;
  veoMode: VeoMode;
  startFrameUrl?: string | null;
  endFrameUrl?: string | null;
  referenceImageUrls?: string[] | null;
}

export interface VeoGenerateBody {
  source: VeoClientSource;
  model: string;
  videoModel: string;
  prompt: string;
  aspect_ratio: string;
  aspectRatio: string;
  generationType: VeoGenerationType;
  imageUrls: string[];
  veoMode: VeoMode;
  enableTranslation: true;
  watermark: "";
  startFrameUrl?: string;
  endFrameUrl?: string;
  resolution?: string;
}

/** Safe URL summary for logs (host + path length only). */
export function veoUrlLog(url: string | null | undefined): string {
  if (!url) return "(none)";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.length > 48 ? u.pathname.slice(0, 48) + "…" : u.pathname} (len=${url.length})`;
  } catch {
    if (url.includes("/generated/")) {
      const idx = url.indexOf("/generated/");
      const path = url.slice(idx);
      return `local:${path.length > 48 ? path.slice(0, 48) + "…" : path} (len=${url.length})`;
    }
    return `(invalid url, len=${url.length})`;
  }
}

export function buildVeoImageUrls(args: {
  veoMode: VeoMode;
  startFrameUrl?: string | null;
  endFrameUrl?: string | null;
  referenceImageUrls?: string[] | null;
}): string[] {
  const start = args.startFrameUrl?.trim() || undefined;
  const end = args.endFrameUrl?.trim() || undefined;
  const refs = (args.referenceImageUrls ?? []).map((u) => u?.trim()).filter(Boolean) as string[];

  if (args.veoMode === "references") {
    if (refs.length > 0) return refs.slice(0, 3);
    const fromFrames = [start, end].filter(Boolean) as string[];
    return fromFrames.slice(0, 3);
  }

  // frames mode
  const urls: string[] = [];
  if (start) urls.push(start);
  if (end) urls.push(end);
  return urls;
}

export function resolveVeoGenerationType(
  veoMode: VeoMode,
  imageUrls: string[],
): VeoGenerationType {
  if (veoMode === "references") {
    return imageUrls.length > 0 ? "REFERENCE_2_VIDEO" : "TEXT_2_VIDEO";
  }
  return imageUrls.length > 0 ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "TEXT_2_VIDEO";
}

/**
 * Build the body both gallery and VideoGeneratorNode send to /api/generate-video.
 * Does not include deprecated enableFallback.
 */
export function buildVeoGenerateBody(args: BuildVeoGenerateBodyArgs): VeoGenerateBody {
  const start = args.startFrameUrl?.trim() || undefined;
  const end = args.endFrameUrl?.trim() || undefined;
  const imageUrls = buildVeoImageUrls({
    veoMode: args.veoMode,
    startFrameUrl: start,
    endFrameUrl: end,
    referenceImageUrls: args.referenceImageUrls,
  });
  const generationType = resolveVeoGenerationType(args.veoMode, imageUrls);

  const body: VeoGenerateBody = {
    source: args.source,
    model: args.modelId,
    videoModel: args.modelId,
    prompt: args.prompt,
    aspect_ratio: args.aspectRatio,
    aspectRatio: args.aspectRatio,
    generationType,
    imageUrls,
    veoMode: args.veoMode,
    enableTranslation: true,
    watermark: "",
  };

  if (start) body.startFrameUrl = start;
  if (end) body.endFrameUrl = end;
  if (args.resolution) body.resolution = args.resolution;

  return body;
}

/** Client-side console summary (browser or node). */
export function logVeoClientPayload(body: VeoGenerateBody): void {
  const sameStartEnd = !!(body.startFrameUrl && body.endFrameUrl
    && body.startFrameUrl.split("?")[0] === body.endFrameUrl.split("?")[0]);
  console.log("[veo:diag:client]", JSON.stringify({
    source: body.source,
    model: body.model,
    videoModel: body.videoModel,
    veoMode: body.veoMode,
    generationType: body.generationType,
    nImageUrls: body.imageUrls.length,
    imageHosts: body.imageUrls.map(veoUrlLog),
    hasStart: !!body.startFrameUrl,
    hasEnd: !!body.endFrameUrl,
    startHost: veoUrlLog(body.startFrameUrl),
    endHost: veoUrlLog(body.endFrameUrl),
    sameStartEnd,
    aspectRatio: body.aspect_ratio,
    resolution: body.resolution ?? "(default)",
    promptLen: body.prompt?.length ?? 0,
    promptHead: (body.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
  }));
}
