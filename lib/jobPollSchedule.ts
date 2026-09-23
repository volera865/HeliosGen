export const JOB_POLL_MAX_MS = 15 * 60 * 1000;

/** Adaptive delay between poll attempts (Kie-style backoff). */
export function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 1_500;
  if (elapsedMs < 120_000) return 3_000;
  return 5_000;
}

export function isPollExpired(startedAt: number): boolean {
  return Date.now() - startedAt >= JOB_POLL_MAX_MS;
}

/** Server-side job-stream Kie poll interval from stream age. */
export function serverPollDelayMs(streamAgeMs: number): number {
  return streamAgeMs < 120_000 ? 2_000 : 5_000;
}
