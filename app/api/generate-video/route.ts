import { NextRequest, NextResponse, after } from "next/server";
import { jobStore } from "@/lib/jobStore";
import { ensureR2 } from "@/lib/r2";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { VIDEO_MODELS } from "@/lib/modelConfig";
import { getKieTokenForUser } from "@/lib/getKieToken";
import { GUEST_MODE, resolveUserId } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { resolveKieCallBackUrl } from "@/lib/kieCallback";
import { veoUrlLog } from "@/lib/veoClientPayload";
import { probeImageUrlsDetailed } from "@/lib/veoUrlProbe";
import {
  hostsEqual,
  promptHead,
  veoDiagFail,
  veoDiagLog,
  veoDiagRemember,
} from "@/lib/veoDiag";
import { ensureKieHostedImageUrl } from "@/lib/kieFileUpload";
import {
  googleFallbackNotice,
  isGoogleVideoModel,
  isVeoDegraded,
  veoOutageState,
  VEO_FALLBACK_MODEL_ID,
} from "@/lib/veoOutage";
import {
  parseTalkingVoice,
  resolveTalkingRoute,
  talkingModelForRoute,
  wrapTalkingPrompt,
  isSeedanceTalkingFamily,
} from "@/lib/talkingPrompt";
import { runTalkingPipeline, talkingParentId } from "@/lib/talkingPipeline";

const KIE_BASE = "https://api.kie.ai";

function isHttpsPublicUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Guest local paths + https are resolvable; blob: is not. */
function isVeoResolvableFrameUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const t = url.trim();
  if (!t || t.startsWith("blob:")) return false;
  if (t.startsWith("https://")) return true;
  if (t.startsWith("data:")) return true;
  if (t.includes("/generated/")) return true;
  return false;
}

function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

interface Resource {
  url: string;
  label: string;
}

interface KlingElementInput {
  name: string;
  description: string;
  imageUrls: string[];
}


export async function POST(req: NextRequest) {
  try {
  const body = await req.json();
  let videoModel: string = body.videoModel || body.model || "kling-3.0";
  let prompt: string | undefined = body.prompt;
  let rawStartFrame: string | undefined = body.startFrameUrl;
  let rawEndFrame: string | undefined = body.endFrameUrl;
  let rawRefImages: string[] = body.referenceImageUrls || body.imageUrls || [];
  let sound: boolean = body.sound ?? false;
  const {
    videoRefUrl:    rawVideoRef,
    resources       = [] as Resource[],
    klingElements   = [] as KlingElementInput[],
    referenceVideoUrls:  rawRefVideoUrls  = [] as string[],
    referenceAudioUrls:  rawRefAudioUrls  = [] as string[],
    duration        = 5,
    aspectRatio     = body.aspect_ratio || "16:9",
    mode            = "pro",
    resolution:     rawResolution,
    seed,
    veoMode,
    generationType: rawGenerationType,
    callBackUrl:    rawCallBackUrl,
    debugOnly       = false,
    talkingMode     = false,
    talkingVoice:   rawTalkingVoice,
    source:         veoSource,
  } = body;

  const hasFace = !!(rawStartFrame && String(rawStartFrame).trim())
    || (Array.isArray(rawRefImages) && rawRefImages.length > 0);
  const hasAudio = Array.isArray(rawRefAudioUrls) && rawRefAudioUrls.length > 0;
  const voice = parseTalkingVoice(rawTalkingVoice);

  if (talkingMode) {
    const route = resolveTalkingRoute({ hasFace, hasAudio });
    videoModel = talkingModelForRoute(route);
    prompt = wrapTalkingPrompt(String(prompt ?? ""), { route, voice, hasFace });
    if (route === "generate") {
      sound = true;
      if (!rawStartFrame && rawRefImages[0]) rawStartFrame = rawRefImages[0];
      rawEndFrame = undefined;
    }
    if (route === "lip-sync" && !rawStartFrame && rawRefImages[0]) {
      rawStartFrame = rawRefImages[0];
    }
    if (route === "audio-only") {
      rawStartFrame = undefined;
      rawEndFrame = undefined;
      rawRefImages = [];
      sound = false;
    }
  } else if (rawTalkingVoice && isSeedanceTalkingFamily(videoModel) && !hasAudio) {
    sound = true;
    prompt = wrapTalkingPrompt(String(prompt ?? ""), { route: "generate", voice, hasFace });
    if (!rawStartFrame && rawRefImages[0]) rawStartFrame = rawRefImages[0];
  }

  const userId = await resolveUserId(req);

  const apiKey = userId ? await getKieTokenForUser(userId) : null;
  if (!apiKey) return NextResponse.json({ error: "No Kie.ai API key configured. Add one in Settings." }, { status: 401 });

  if (talkingMode) {
    const topic = String(body.prompt ?? "");
    let faceUrl = (rawStartFrame && String(rawStartFrame).trim()) || rawRefImages[0] || undefined;
    let audioUrl = Array.isArray(rawRefAudioUrls) && rawRefAudioUrls[0] ? String(rawRefAudioUrls[0]) : undefined;
    if (!audioUrl && !topic.trim()) {
      return NextResponse.json({ error: "Describe what they should say, or upload audio." }, { status: 400 });
    }
    if (faceUrl) {
      const resolved = await ensureR2(faceUrl, "references").catch(() => faceUrl);
      faceUrl = typeof resolved === "string" ? resolved : faceUrl;
    }
    if (audioUrl) {
      const resolved = await ensureR2(audioUrl, "references").catch(() => audioUrl);
      audioUrl = typeof resolved === "string" ? resolved : audioUrl;
    }
    const parentId = talkingParentId();
    const phase = audioUrl ? (faceUrl ? "lip-sync" : "generating") : "creating-voice";
    const displayModel = faceUrl ? "kling-ai-avatar-standard" : "seedance-2-5";
    jobStore.set(parentId, { status: "pending", type: "video", userId: userId ?? undefined, phase });
    const refs = [faceUrl, audioUrl].filter((u): u is string => !!u);
    if (GUEST_MODE) {
      guestDb.insertGeneration({
        task_id: parentId, user_id: userId, generation_type: "video",
        status: "pending", model: displayModel, prompt: topic,
        aspect_ratio: aspectRatio, duration: Number(duration) || 5,
        kling_mode: mode, sound: true, reference_image_urls: refs,
      });
    } else {
      supabaseAdmin.from("generations").insert({
        task_id: parentId, user_id: userId, generation_type: "video",
        status: "pending", model: displayModel, prompt: topic,
        aspect_ratio: aspectRatio, duration: Number(duration) || 5,
        kling_mode: mode, sound: true, reference_image_urls: refs,
      }).then(({ error }) => {
        if (error) console.error("[generate-video] talking insert error:", error.message);
      });
    }
    after(() => runTalkingPipeline({
      parentId,
      apiKey,
      userId: userId ?? undefined,
      topic,
      voice,
      faceUrl,
      audioUrl,
      aspectRatio,
      duration: Number(duration) || 5,
    }));
    return NextResponse.json({ taskId: parentId });
  }

  const callBackUrl = rawCallBackUrl || resolveKieCallBackUrl();

  // kie's Google video channel sometimes accepts jobs then fails all of them
  // with an opaque 500. Once detected, route to a working model instead of
  // queueing work that cannot finish.
  let veoFallbackFrom: string | null = null;
  if (isGoogleVideoModel(videoModel)) {
    veoDiagLog("outage-check", {
      model: videoModel,
      degraded: isVeoDegraded(),
      outage: veoOutageState(),
    });
  }
  if (isGoogleVideoModel(videoModel) && isVeoDegraded()) {
    veoFallbackFrom = videoModel;
    videoModel = VEO_FALLBACK_MODEL_ID;
    veoDiagLog("auto-fallback", {
      from: veoFallbackFrom,
      to: videoModel,
      outage: veoOutageState(),
      source: typeof veoSource === "string" ? veoSource : "unknown",
    });
  }

  const cfg = VIDEO_MODELS.find((m) => m.id === videoModel);
  if (!cfg) return NextResponse.json({ error: `Unknown video model: ${videoModel}` }, { status: 400 });

  const resolution = rawResolution || cfg.defaultResolution || "480p";
  const { apiInput } = cfg;
  const isSeedance25EditModel = cfg.id === "seedance-2-5-edit";
  const seedanceHasEndpointFrame = isSeedanceTalkingFamily(videoModel)
    && !!(rawStartFrame || rawEndFrame);
  const effectiveAspectRatio = isSeedance25EditModel || seedanceHasEndpointFrame
    ? "adaptive"
    : aspectRatio;

  // Clamp duration to model limits (motion-control has no duration field)
  const clampedDuration = isSeedance25EditModel
    ? -1
    : apiInput.durationMax > 0
    ? Math.max(apiInput.durationMin, Math.min(apiInput.durationMax, Number(duration)))
    : 0;

  let input: Record<string, unknown>;
  let effectiveApiId = cfg.apiId;
  let veoDiagSnap: Parameters<typeof veoDiagRemember>[1] | null = null;

  if (apiInput.useMotionControl) {
    // ── Kling 2.6 motion control ──────────────────────────────────────────────
    // { prompt, input_urls, video_urls, mode, character_orientation }
    const [inputImageUrl, inputVideoUrl] = await Promise.all([
      rawStartFrame ? ensureR2(rawStartFrame, "references").catch(() => rawStartFrame) : Promise.resolve(undefined),
      rawVideoRef   ? ensureR2(rawVideoRef,   "references").catch(() => rawVideoRef)   : Promise.resolve(undefined),
    ]);

    input = {
      prompt:                prompt ?? "",
      input_urls:            inputImageUrl ? [inputImageUrl] : [],
      video_urls:            inputVideoUrl ? [inputVideoUrl] : [],
      mode:                  resolution,   // "720p" or "1080p"
      character_orientation: mode,         // "image" or "video"
    };
    if (apiInput.extra) Object.assign(input, apiInput.extra);

  } else if (apiInput.useKlingAiAvatar) {
    // ── Kling AI Avatar (face image + audio → talking video) ─────────────────
    // { image_url, audio_url, prompt } only — no duration / aspect / resolution
    const avatarErr = "Kling AI Avatar needs one face image and one audio file.";
    const rawAudio = (rawRefAudioUrls as string[])[0];
    if (!rawStartFrame || !rawAudio) {
      return NextResponse.json({ error: avatarErr }, { status: 400 });
    }
    if (!String(prompt ?? "").trim()) {
      return NextResponse.json({ error: "Kling AI Avatar needs a prompt." }, { status: 400 });
    }
    const [imageUrl, audioUrl] = await Promise.all([
      ensureR2(rawStartFrame, "references").catch(() => rawStartFrame),
      ensureR2(rawAudio, "references").catch(() => rawAudio),
    ]);
    if (
      typeof imageUrl !== "string" || !imageUrl.startsWith("https:") ||
      typeof audioUrl !== "string" || !audioUrl.startsWith("https:")
    ) {
      return NextResponse.json({ error: avatarErr }, { status: 400 });
    }
    input = {
      image_url: imageUrl,
      audio_url: audioUrl,
      prompt:    String(prompt).trim(),
    };

  } else if (apiInput.firstFrameKey) {
    // ── Seedance-style models (separate frame keys + multi-ref arrays) ─────────
    const [startFrameUrl, endFrameUrl, r2RefImages, r2RefVideos, r2RefAudios] = await Promise.all([
      rawStartFrame ? ensureR2(rawStartFrame, "references").catch(() => rawStartFrame) : Promise.resolve(undefined),
      rawEndFrame   ? ensureR2(rawEndFrame,   "references").catch(() => rawEndFrame)   : Promise.resolve(undefined),
      Promise.all((rawRefImages    as string[]).map((u) => ensureR2(u, "references").catch(() => u))),
      Promise.all((rawRefVideoUrls as string[]).map((u) => ensureR2(u, "references").catch(() => u))),
      Promise.all((rawRefAudioUrls as string[]).map((u) => ensureR2(u, "references").catch(() => u))),
    ]);

    input = {
      [apiInput.aspectRatioKey!]: effectiveAspectRatio,
      [apiInput.durationKey!]:    clampedDuration,
    };

    if (prompt?.trim())                                        input.prompt                       = prompt;
    if (apiInput.firstFrameKey  && startFrameUrl)              input[apiInput.firstFrameKey]       = startFrameUrl;
    // last_frame_url cannot be sent alone
    if (apiInput.lastFrameKey && endFrameUrl && startFrameUrl) input[apiInput.lastFrameKey]        = endFrameUrl;
    if (apiInput.resolutionKey)                                input[apiInput.resolutionKey]       = resolution;
    if (apiInput.soundKey)                                     input[apiInput.soundKey]            = Boolean(sound);
    // Official Seedance rule: first/last-frame jobs cannot include any reference_* lists
    const seedanceUsesEndpointFrames = !!(startFrameUrl || endFrameUrl);
    if (!seedanceUsesEndpointFrames) {
      if (apiInput.referenceImagesKey && r2RefImages.length > 0) input[apiInput.referenceImagesKey] = r2RefImages;
      if (apiInput.referenceVideosKey && r2RefVideos.length > 0) input[apiInput.referenceVideosKey] = r2RefVideos;
      if (apiInput.referenceAudiosKey && r2RefAudios.length > 0) input[apiInput.referenceAudiosKey] = r2RefAudios;
    }
    if (apiInput.extra)                                        Object.assign(input, apiInput.extra);

  } else if (apiInput.useHappyHorse) {
    // ── HappyHorse (Alibaba) — routes to text/image/reference endpoint ────────
    const refImageUrls = (
      await Promise.all(
        (rawRefImages as string[]).map((u) => ensureR2(u, "references").catch(() => null))
      )
    ).filter((u): u is string => u !== null);

    const startFrameUrl = rawStartFrame
      ? await ensureR2(rawStartFrame, "references").catch(() => rawStartFrame)
      : undefined;

    const maybeSeed = seed !== undefined && seed !== null && Number(seed) > 0 ? Number(seed) : undefined;

    if (refImageUrls.length > 0) {
      effectiveApiId = "happyhorse/reference-to-video";
      input = {
        prompt: prompt ?? "",
        reference_image: refImageUrls.slice(0, 9),
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
      if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;
    } else if (startFrameUrl) {
      effectiveApiId = "happyhorse/image-to-video";
      input = {
        image_urls:             [startFrameUrl],
        [apiInput.durationKey!]: clampedDuration,
      };
      if (prompt?.trim()) input.prompt = prompt;
      // resolution is determined by the input image — do not send it
      if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;
    } else {
      effectiveApiId = "happyhorse/text-to-video";
      input = {
        prompt: prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
      if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;
    }

  } else if (apiInput.useKlingTurbo) {
    // ── Kling 3.0 Turbo (text-to-video / image-to-video) ─────────────────────
    const startFrameUrl = rawStartFrame
      ? await ensureR2(rawStartFrame, "references").catch(() => rawStartFrame)
      : undefined;

    const durationValue = String(clampedDuration);

    if (startFrameUrl) {
      effectiveApiId = cfg.imageApiId!;
      input = {
        prompt:              prompt ?? "",
        image_urls:          [startFrameUrl],
        [apiInput.durationKey!]: durationValue,
        [apiInput.resolutionKey!]: resolution,
      };
    } else {
      effectiveApiId = cfg.apiId;
      input = {
        prompt:                     prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    durationValue,
        [apiInput.resolutionKey!]:  resolution,
      };
    }

  } else if (apiInput.useGoogleVeo) {
    // ── Google Veo 3.1 ───────────────────────────────────────────────────────
    // Gallery / workflow send imageUrls + start/end via buildVeoGenerateBody.
    // Still map imageUrls → FLF when start/end missing (defense in depth).
    // Guest mode often sends /generated/... paths (not https yet) — accept those,
    // ensureR2/local, then force-rehost onto kie CDN so Veo can fetch them.
    const sourceTag = typeof veoSource === "string" ? veoSource : "unknown";
    const wantsFlf =
      rawGenerationType === "FIRST_AND_LAST_FRAMES_2_VIDEO"
      || veoMode === "frames"
      || veoMode == null
      || veoMode === undefined;
    const wantsRefs =
      rawGenerationType === "REFERENCE_2_VIDEO"
      || veoMode === "references";

    let veoStart = isVeoResolvableFrameUrl(rawStartFrame) ? String(rawStartFrame).trim() : undefined;
    let veoEnd = isVeoResolvableFrameUrl(rawEndFrame) ? String(rawEndFrame).trim() : undefined;
    // Client may send good imageUrls even when startFrameUrl/endFrameUrl are blob/invalid
    const resolvableRefs = (rawRefImages as string[]).filter(isVeoResolvableFrameUrl);

    if (wantsFlf && !wantsRefs) {
      if (!veoStart && resolvableRefs[0]) veoStart = resolvableRefs[0];
      if (!veoEnd && resolvableRefs[1]) veoEnd = resolvableRefs[1];
    }

    if (wantsFlf && !wantsRefs && !veoStart && !veoEnd && resolvableRefs.length === 0) {
      console.warn("[veo] frames mode but zero resolvable frame URLs", { source: sourceTag, model: videoModel });
    }

    if ((rawStartFrame && !veoStart) || (rawEndFrame && !veoEnd)) {
      veoDiagLog("dropped-unresolvable-frame", {
        source: sourceTag,
        rawStartOk: isVeoResolvableFrameUrl(rawStartFrame),
        rawEndOk: isVeoResolvableFrameUrl(rawEndFrame),
        rawStart: veoUrlLog(rawStartFrame),
        rawEnd: veoUrlLog(rawEndFrame),
        resolvableRefCount: resolvableRefs.length,
      });
    }

    async function publishVeoFrame(url: string): Promise<string> {
      const afterR2 = await ensureR2(url, "references").catch(() => url);
      const hosted = await ensureKieHostedImageUrl(afterR2);
      if (!isHttpsPublicUrl(hosted)) {
        throw new Error(`Frame did not resolve to https after kie publish: ${veoUrlLog(url)}`);
      }
      return hosted;
    }

    let startFrameUrl: string | undefined;
    let endFrameUrl: string | undefined;
    let refImages: string[] = [];
    try {
      const published = await Promise.all([
        veoStart ? publishVeoFrame(veoStart) : Promise.resolve(undefined as string | undefined),
        veoEnd ? publishVeoFrame(veoEnd) : Promise.resolve(undefined as string | undefined),
        Promise.all(resolvableRefs.map((u) => publishVeoFrame(u))),
      ]);
      startFrameUrl = published[0];
      endFrameUrl = published[1];
      refImages = published[2];
      veoDiagLog("frames-published", {
        source: sourceTag,
        startHost: veoUrlLog(startFrameUrl),
        endHost: veoUrlLog(endFrameUrl),
        refHosts: refImages.map(veoUrlLog),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to publish frame URLs for Veo";
      console.error("[veo] frame publish failed", { source: sourceTag, error: msg });
      veoDiagLog("frame-publish-failed", { source: sourceTag, error: msg });
      return NextResponse.json(
        { error: `Could not publish frame images for Veo — ${msg}` },
        { status: 400 },
      );
    }

    const imageUrls: string[] = [];
    let generationType = "TEXT_2_VIDEO";

    // REFERENCE_2_VIDEO is supported on Fast and Lite (kie Veo 3.1 docs).
    if (wantsRefs && (veoMode === "references" || rawGenerationType === "REFERENCE_2_VIDEO")) {
      generationType = "REFERENCE_2_VIDEO";
      const refs = refImages.length > 0
        ? refImages
        : [startFrameUrl, endFrameUrl].filter((u): u is string => !!u);
      if (refs.length > 0) imageUrls.push(...refs.filter(isHttpsPublicUrl).slice(0, 3));
    } else if (startFrameUrl || endFrameUrl) {
      generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO";
      if (startFrameUrl && isHttpsPublicUrl(startFrameUrl)) imageUrls.push(startFrameUrl);
      if (endFrameUrl && isHttpsPublicUrl(endFrameUrl)) imageUrls.push(endFrameUrl);
      // If end was dropped (blob/invalid) but client sent 2 https imageUrls, restore second
      if (imageUrls.length === 1 && refImages[1] && isHttpsPublicUrl(refImages[1])) {
        imageUrls.push(refImages[1]);
      }
    } else if (wantsFlf && refImages.length > 0) {
      generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO";
      imageUrls.push(...refImages.filter(isHttpsPublicUrl).slice(0, 2));
    }

    // Never send FLF/reference with an empty image list — kie returns opaque Internal Error
    const resolvedType = rawGenerationType || generationType;
    let finalType =
      (resolvedType === "FIRST_AND_LAST_FRAMES_2_VIDEO" || resolvedType === "REFERENCE_2_VIDEO")
      && imageUrls.length === 0
        ? "TEXT_2_VIDEO"
        : resolvedType;

    effectiveApiId = cfg.apiId; // Use veo3, veo3_fast, or veo3_lite directly

    // Docs: FLF with 2 images = morph/transition first→last. Dissimilar assets
    // (person→product) reliably return opaque Internal Error 500. REFERENCE_2_VIDEO
    // is the correct mode for multi-asset product ads (Lite + Fast only).
    if (
      finalType === "FIRST_AND_LAST_FRAMES_2_VIDEO"
      && imageUrls.length === 2
    ) {
      const o0 = urlOrigin(imageUrls[0]);
      const o1 = urlOrigin(imageUrls[1]);
      const mismatchedOrigins = !!(o0 && o1 && o0 !== o1);
      if (mismatchedOrigins) {
        if (effectiveApiId === "veo3_fast" || effectiveApiId === "veo3_lite") {
          veoDiagLog("coerce-flf-to-reference", {
            source: sourceTag,
            reason: "mismatched-frame-origins",
            o0,
            o1,
            apiId: effectiveApiId,
          });
          finalType = "REFERENCE_2_VIDEO";
        } else {
          return NextResponse.json({
            error:
              "Start and end frames are from different sources. Veo Quality first→last mode morphs between them and often fails (Internal Error). Use References mode, or pick matching frames from the same scene, or switch to Veo Fast/Lite.",
          }, { status: 400 });
        }
      }
    }

    // REFERENCE_2_VIDEO is not supported on Quality veo3
    if (finalType === "REFERENCE_2_VIDEO" && effectiveApiId === "veo3") {
      return NextResponse.json(
        { error: "Reference mode is not supported on Veo 3.1 Quality. Switch to Veo Fast or Lite, or use Frames mode with matching start/end frames." },
        { status: 400 },
      );
    }

    const finalImageUrls = finalType === "TEXT_2_VIDEO" ? [] : imageUrls;

    // kie Veo only accepts 16:9 | 9:16 | Auto — reject (or coerce) others early
    // instead of opaque upstream "Ratio error" / Internal Error.
    const veoAspectAllowed = new Set(["16:9", "9:16", "Auto", "auto"]);
    let veoAspect = String(aspectRatio ?? "16:9");
    if (!veoAspectAllowed.has(veoAspect)) {
      veoDiagLog("coerce-aspect", {
        source: sourceTag,
        from: veoAspect,
        to: "Auto",
        reason: "veo-only-allows-16:9-9:16-Auto",
      });
      veoAspect = "Auto";
    } else if (veoAspect === "auto") {
      veoAspect = "Auto";
    }

    const probeResults = finalImageUrls.length > 0
      ? await probeImageUrlsDetailed(finalImageUrls)
      : [];
    veoDiagLog("probe", {
      source: sourceTag,
      results: probeResults.map((r) => ({
        host: r.host,
        ok: r.ok,
        status: r.status,
        method: r.method,
        error: r.error,
      })),
    });

    if (finalImageUrls.length > 0) {
      const bad = probeResults.find((r) => !r.ok);
      if (bad) {
        const unreachable = `Frame URL not publicly reachable — re-upload and try again (${bad.host}${bad.status ? ` HTTP ${bad.status}` : ""}${bad.error ? ` ${bad.error}` : ""})`;
        console.error("[veo] unreachable imageUrls", { source: sourceTag, detail: unreachable });
        veoDiagLog("reject-unreachable", { source: sourceTag, unreachable, probeResults });
        return NextResponse.json({ error: unreachable }, { status: 400 });
      }
    }

    const startHost = startFrameUrl ? veoUrlLog(startFrameUrl) : undefined;
    const endHost = endFrameUrl ? veoUrlLog(endFrameUrl) : undefined;
    const sameStartEnd = hostsEqual(startFrameUrl, endFrameUrl);

    veoDiagLog("server-resolve", {
      source: sourceTag,
      videoModel,
      apiId: effectiveApiId,
      veoMode: veoMode ?? "(unset)",
      rawGenerationType: rawGenerationType ?? "(unset)",
      rawStart: veoUrlLog(rawStartFrame),
      rawEnd: veoUrlLog(rawEndFrame),
      rawRefCount: Array.isArray(rawRefImages) ? rawRefImages.length : 0,
      finalType,
      nImageUrls: finalImageUrls.length,
      imageHosts: finalImageUrls.map(veoUrlLog),
      startHost,
      endHost,
      sameStartEnd,
      aspectRatio: veoAspect,
      resolution,
      promptLen: (prompt ?? "").length,
      promptHead: promptHead(prompt),
      bodyKeys: Object.keys(body ?? {}),
    });

    // stash for remember after taskId
    veoDiagSnap = {
      source: sourceTag,
      model: videoModel,
      apiId: effectiveApiId,
      veoMode: String(veoMode ?? ""),
      generationType: finalType,
      aspectRatio: veoAspect,
      resolution: String(resolution ?? ""),
      promptLen: (prompt ?? "").length,
      promptHead: promptHead(prompt),
      nImageUrls: finalImageUrls.length,
      imageHosts: finalImageUrls.map(veoUrlLog),
      startHost,
      endHost,
      sameStartEnd,
      probe: probeResults.map((r) => ({
        host: r.host,
        ok: r.ok,
        status: r.status,
        method: r.method,
      })),
    };

    input = {
      prompt: prompt ?? "",
      generationType: finalType,
      [apiInput.aspectRatioKey!]: veoAspect,
      [apiInput.resolutionKey!]: resolution,
      imageUrls: finalImageUrls,
      watermark: "",
      // enableFallback intentionally omitted — deprecated in kie docs
      enableTranslation: true,
      ...(callBackUrl ? { callBackUrl } : {}),
    };
    if (apiInput.extra) Object.assign(input, apiInput.extra);

  } else if (apiInput.useGeminiOmniVideo) {
    // ── Gemini Omni Video (quota-based: image=1 slot, video=2 slots, max 7) ────
    const r2RefImages = await Promise.all(
      (rawRefImages as string[]).map((u) => ensureR2(u, "references").catch(() => u))
    );
    const r2RefVideos = await Promise.all(
      (rawRefVideoUrls as string[]).slice(0, 1).map((u) => ensureR2(u, "references").catch(() => u))
    );

    const videoSlots = r2RefVideos.length > 0 ? 2 : 0;
    const clampedImages = r2RefImages.slice(0, 7 - videoSlots);

    const maybeSeed = seed !== undefined && seed !== null && Number(seed) > 0 ? Number(seed) : undefined;

    input = { prompt: prompt ?? "" };
    if (clampedImages.length > 0) input.image_urls = clampedImages;
    if (r2RefVideos.length > 0)   input.video_list = r2RefVideos.map((url) => ({ url, start: 0, ends: 10 }));
    // duration is ignored by the model when video input is provided
    if (r2RefVideos.length === 0) input[apiInput.durationKey!] = String(clampedDuration);
    if (apiInput.aspectRatioKey)  input[apiInput.aspectRatioKey] = aspectRatio;
    if (apiInput.resolutionKey)   input[apiInput.resolutionKey]  = resolution;
    if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;

  } else if (apiInput.referenceImagesKey) {
    // ── Reference-image-based models (Grok Imagine, Grok Imagine 1.5) ─────────
    const refImageUrls = (
      await Promise.all(
        (rawRefImages as string[]).map((u) => ensureR2(u, "references").catch(() => null))
      )
    ).filter((u): u is string => u !== null);

    const hasImages = refImageUrls.length > 0;
    effectiveApiId = hasImages && cfg.imageApiId ? cfg.imageApiId : cfg.apiId;

    const durationValue = apiInput.durationAsString ? String(clampedDuration) : clampedDuration;

    input = {
      prompt:                     prompt ?? "",
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.durationKey!]:    durationValue,
    };

    if (apiInput.modeKey)       input[apiInput.modeKey]       = mode;
    if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
    if (apiInput.extra)         Object.assign(input, apiInput.extra);
    if (hasImages) input[apiInput.referenceImagesKey] = refImageUrls;

  } else {
    // ── Start/end-frame + elements models (Kling) ─────────────────────────────
    const hasNewElements = (klingElements as KlingElementInput[]).length > 0;

    const [startFrameUrl, endFrameUrl, r2Resources, uploadedElements] = await Promise.all([
      rawStartFrame ? ensureR2(rawStartFrame, "references") : Promise.resolve(undefined),
      rawEndFrame   ? ensureR2(rawEndFrame,   "references") : Promise.resolve(undefined),
      hasNewElements
        ? Promise.resolve([] as Resource[])
        : Promise.all(
            (resources as Resource[]).slice(0, 3).map(async (r) => ({
              ...r,
              url: await ensureR2(r.url, "references").catch(() => r.url),
            }))
          ),
      hasNewElements
        ? Promise.all(
            (klingElements as KlingElementInput[]).slice(0, 3).map(async (el) => ({
              name:        el.name,
              description: el.description,
              imageUrls:   await Promise.all(
                el.imageUrls.map((u) => ensureR2(u, "references").catch(() => u))
              ),
            }))
          )
        : Promise.resolve([] as { name: string; description: string; imageUrls: string[] }[]),
    ]);

    input = {
      prompt:                     prompt ?? "",
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.durationKey!]:    apiInput.durationAsString ? String(clampedDuration) : clampedDuration,
    };

    if (apiInput.modeKey)  input[apiInput.modeKey]  = mode;
    if (apiInput.soundKey) input[apiInput.soundKey] = Boolean(sound);
    if (apiInput.extra)    Object.assign(input, apiInput.extra);

    if (apiInput.useImageUrls) {
      const image_urls: string[] = [];
      if (startFrameUrl) image_urls.push(startFrameUrl);
      if (endFrameUrl)   image_urls.push(endFrameUrl);
      if (image_urls.length > 0) input.image_urls = image_urls;
    }

    if (apiInput.useKlingElements) {
      let kling_elements: { name: string; description: string; element_input_urls: string[] }[] = [];
      if (hasNewElements) {
        kling_elements = uploadedElements.map((el) => ({
          name:               el.name,
          description:        el.description,
          element_input_urls: el.imageUrls.length >= 2 ? el.imageUrls : [el.imageUrls[0], el.imageUrls[0]],
        }));
      } else {
        kling_elements = r2Resources.map((r) => {
          const safeName = r.label.toLowerCase().replace(/\s+#/g, "_").replace(/[^a-z0-9_]/g, "") || "element";
          return { name: safeName, description: r.label, element_input_urls: [r.url, r.url] };
        });
      }
      if (kling_elements.length > 0) input.kling_elements = kling_elements;
    }
  }

  // Submit task to kie.ai
  // Google Veo models require a dedicated endpoint and a flattened structure
  const endpoint = apiInput.useGoogleVeo
    ? `${KIE_BASE}/api/v1/veo/generate`
    : `${KIE_BASE}/api/v1/jobs/createTask`;

  const kieBody = apiInput.useGoogleVeo
    ? { model: effectiveApiId, ...input }
    : { model: effectiveApiId, input, ...(callBackUrl ? { callBackUrl } : {}) };

  // Debug mode — log payload to server console and return without submitting
  if (debugOnly) {
    console.log(`[DEBUG] generate-video payload → ${endpoint}`, JSON.stringify(kieBody, null, 2));
    return NextResponse.json({ debugPayload: kieBody, debugEndpoint: endpoint });
  }

  console.log(`[generate-video] sending to ${endpoint}:`, JSON.stringify(kieBody));
  if (apiInput.useGoogleVeo) {
    console.log("[veo] kie submit", {
      endpoint,
      model: effectiveApiId,
      generationType: (input as { generationType?: string }).generationType,
      nImageUrls: Array.isArray((input as { imageUrls?: string[] }).imageUrls)
        ? (input as { imageUrls: string[] }).imageUrls.length
        : 0,
    });
  }
  const createRes = await fetch(endpoint, {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body:    JSON.stringify(kieBody),
  });

  if (!createRes.ok) {
    if (createRes.status === 401) {
      return NextResponse.json({ error: "Invalid Kie.ai API key — please update it in Settings." }, { status: 401 });
    }
    if (createRes.status === 429) {
      return NextResponse.json({ error: "kie.ai is rate limiting requests. Wait a few seconds and try again." }, { status: 429 });
    }
    const errText = await createRes.text();
    console.error("[generate-video] kie.ai HTTP error:", createRes.status, errText);
    if (apiInput.useGoogleVeo) console.error("[veo] kie HTTP error", createRes.status, errText.slice(0, 400));
    return NextResponse.json({ error: errText }, { status: 500 });
  }

  const createdText = await createRes.text();
  console.log("[generate-video] kie.ai response:", createdText);
  if (apiInput.useGoogleVeo) {
    try {
      const created = JSON.parse(createdText) as { code?: number; msg?: string; data?: { taskId?: string } };
      console.log("[veo] kie create ok", {
        code: created.code,
        msg: created.msg,
        taskId: created.data?.taskId ?? "(none)",
      });
    } catch {
      console.log("[veo] kie create raw", createdText.slice(0, 200));
    }
  }
  let created: { code?: number; msg?: string; data?: { taskId?: string; id?: string } };
  try {
    created = JSON.parse(createdText);
  } catch {
    return NextResponse.json({ error: `Upstream returned non-JSON: ${createdText.slice(0, 200)}` }, { status: 500 });
  }
  if (created.code !== 200) {
    console.error("[generate-video] kie.ai API error:", created.code, created.msg, "input:", JSON.stringify(input));
    return NextResponse.json({ error: created.msg ?? "Task creation failed" }, { status: 500 });
  }

  const taskId = created.data?.taskId || created.data?.id;
  if (!taskId) return NextResponse.json({ error: "No taskId returned" }, { status: 500 });

  if (veoDiagSnap) {
    let callBackHost: string | undefined;
    try {
      if (callBackUrl) callBackHost = new URL(callBackUrl).host;
    } catch { /* ignore */ }
    veoDiagRemember(taskId, { ...veoDiagSnap, callBackHost });
    veoDiagLog("task-created", {
      taskId: taskId.slice(0, 16),
      apiId: effectiveApiId,
      generationType: (input as { generationType?: string }).generationType,
      nImageUrls: Array.isArray((input as { imageUrls?: string[] }).imageUrls)
        ? (input as { imageUrls: string[] }).imageUrls.length
        : 0,
      callBackHost,
    });
  }

  // Register as pending so the frontend can poll job-status
  jobStore.set(taskId, { status: "pending", type: "video", userId: userId ?? undefined });

  // Save to Supabase (fire-and-forget)

  const referenceUrls: string[] = apiInput.useGoogleVeo
    ? ((input.imageUrls as string[] | undefined) ?? [])
    : apiInput.useMotionControl
    ? [
        ...((input.input_urls as string[] | undefined) ?? []),
        ...((input.video_urls as string[] | undefined) ?? []),
      ]
    : apiInput.useKlingAiAvatar
    ? [
        ...((typeof input.image_url === "string" ? [input.image_url] : [])),
        ...((typeof input.audio_url === "string" ? [input.audio_url] : [])),
      ]
    : apiInput.useGeminiOmniVideo
    ? [
        ...((input.image_urls as string[] | undefined) ?? []),
        ...((input.video_list as Array<{ url: string }> | undefined)?.map((v) => v.url) ?? []),
      ]
    : apiInput.referenceImagesKey
    ? (input[apiInput.referenceImagesKey] as string[] | undefined) ?? []
    : [
        ...((input.image_urls as string[] | undefined) ?? []),
        ...((input.kling_elements as Array<{ element_input_urls: string[] }> | undefined)
          ?.map((el) => el.element_input_urls[0]) ?? []),
      ];

  if (GUEST_MODE) {
    guestDb.insertGeneration({
      task_id: taskId, user_id: userId, generation_type: "video",
      status: "pending", model: videoModel, prompt, aspect_ratio: effectiveAspectRatio,
      duration: clampedDuration, kling_mode: mode,
      sound: cfg.sound ? Boolean(sound) : false,
      reference_image_urls: referenceUrls,
    });
  } else {
    supabaseAdmin.from("generations").insert({
      task_id:              taskId,
      user_id:              userId,
      generation_type:      "video",
      status:               "pending",
      model:                videoModel,
      prompt,
      aspect_ratio:         effectiveAspectRatio,
      duration:             clampedDuration,
      kling_mode:           mode,
      sound:                cfg.sound ? Boolean(sound) : false,
      reference_image_urls: referenceUrls,
    }).then(({ error }) => {
      if (error) console.error("[generate-video] supabase insert error:", error.message);
    });
  }

  return NextResponse.json(
    veoFallbackFrom
      ? { taskId, fallbackFrom: veoFallbackFrom, fallbackTo: videoModel, notice: googleFallbackNotice(veoFallbackFrom) }
      : { taskId },
  );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && (e as NodeJS.ErrnoException).cause;
    console.error("[generate-video] unhandled error:", msg, cause ?? "");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
