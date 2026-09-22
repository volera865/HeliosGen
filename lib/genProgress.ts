export type GenPhase = "starting" | "queued" | "generating" | "saving";

export function normalizeKiePhase(state?: string | null): GenPhase {
  const s = (state ?? "").toLowerCase();
  if (!s || s === "waiting" || s === "queued" || s === "queuing" || s === "queue") return "queued";
  if (s === "generating" || s === "running" || s === "processing" || s === "working") return "generating";
  return "generating";
}

export function phaseLabel(phase?: string | null, prePending?: boolean): string {
  if (prePending) return "Starting…";
  if (phase === "creating-voice") return "Creating voice…";
  if (phase === "lip-sync") return "Lip-sync…";
  if (phase === "queued" || phase === "waiting") return "In queue…";
  if (phase === "saving") return "Saving…";
  return "Generating…";
}

/** Soft estimate only — Kie does not send a real percentage. */
export function phaseProgress(phase?: string | null, elapsedSec = 0, prePending?: boolean): number {
  if (prePending) return 4;
  if (phase === "creating-voice") return Math.min(28, 10 + elapsedSec * 0.2);
  if (phase === "lip-sync") return Math.min(70, 36 + elapsedSec * 0.12);
  if (phase === "queued" || phase === "waiting") return Math.min(22, 8 + elapsedSec * 0.05);
  if (phase === "saving") return 92;
  return Math.min(86, 30 + elapsedSec * 0.15);
}

export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}
