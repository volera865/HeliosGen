/**
 * Map kie Veo / job failure codes + messages to user-facing error text.
 * Used by callback and kieJobSync so gallery tiles and workflow nodes match.
 */

export function mapKieFailMessage(opts: {
  code?: number | null;
  msg?: string | null;
  failMsg?: string | null;
  /** True when the failed job had frame/reference imageUrls */
  hadFrames?: boolean;
  /** Number of imageUrls on the job when known (avoids morph hint on 1-frame) */
  nImageUrls?: number | null;
}): string {
  const code = opts.code;
  const raw = String(opts.failMsg ?? opts.msg ?? "Generation failed").trim() || "Generation failed";
  const n = opts.nImageUrls ?? null;
  const twoFrameFlf = opts.hadFrames && (n == null || n >= 2);

  if (code === 400) {
    return raw;
  }
  if (code === 422) {
    return `${raw} Try a different model or simplify the prompt/frames.`;
  }
  if (code === 501) {
    return raw.startsWith("Generation failed") ? raw : `Generation failed — ${raw}`;
  }
  if (code === 500 || /internal error/i.test(raw)) {
    if (twoFrameFlf) {
      return `${raw} Upstream Veo glitch (not a local crash). Retry once; if it keeps failing with two frames, use the same continuous scene, or References / a single start frame.`;
    }
    if (opts.hadFrames) {
      return `${raw} Upstream Veo glitch with image frames — retry once, or try text-only / another model.`;
    }
    return `${raw} Upstream timed out or failed — retry, or try a lower resolution.`;
  }
  return raw;
}
