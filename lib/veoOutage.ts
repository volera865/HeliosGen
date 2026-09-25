/**
 * Veo outage tracker.
 *
 * kie's Veo 3.1 channel intermittently accepts jobs (HTTP 200 + taskId) and
 * then fails every one of them with `500 Internal Error, Please try again
 * later.` — text-to-video included, on both the legacy `veo/generate` and the
 * current `jobs/createTask` endpoints. Verified live 2026-09-26: every Veo mode
 * failed while Seedance 2 Fast succeeded with the same frames and account.
 *
 * During such an outage we route new Veo requests to a working model instead of
 * burning the user's time on jobs that cannot succeed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const STATE_FILE = join(process.cwd(), "data", "veo-outage.json");

/** Consecutive Veo 500s before we consider the channel down. */
const FAIL_THRESHOLD = 2;
/** Ignore failures older than this when deciding (ms). */
const WINDOW_MS = 30 * 60 * 1000;

export interface VeoOutageState {
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastFailMsg: string | null;
}

const EMPTY: VeoOutageState = {
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastFailMsg: null,
};

// Survive Next dev HMR, fall back to disk across restarts.
const globalRef = globalThis as typeof globalThis & { __veoOutage?: VeoOutageState };

function load(): VeoOutageState {
  if (globalRef.__veoOutage) return globalRef.__veoOutage;
  try {
    if (existsSync(STATE_FILE)) {
      const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<VeoOutageState>;
      globalRef.__veoOutage = { ...EMPTY, ...parsed };
      return globalRef.__veoOutage;
    }
  } catch {
    // corrupt state file — start clean
  }
  globalRef.__veoOutage = { ...EMPTY };
  return globalRef.__veoOutage;
}

function save(state: VeoOutageState): void {
  globalRef.__veoOutage = state;
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
  } catch {
    // in-memory state is enough if the disk write fails
  }
}

export function isVeoModel(modelId: string | null | undefined): boolean {
  const id = String(modelId ?? "");
  return id === "veo3" || id === "veo3_fast" || id === "veo3_lite" || id.startsWith("veo-3");
}

/** True when the failure is the opaque upstream Veo outage signature. */
export function isVeoOutageFailure(opts: {
  code?: number | string | null;
  failMsg?: string | null;
}): boolean {
  const code = Number(opts.code);
  const msg = String(opts.failMsg ?? "");
  return code === 500 || /internal error/i.test(msg);
}

export function recordVeoFailure(failMsg?: string | null): VeoOutageState {
  const prev = load();
  const stale = prev.lastFailureAt !== null && Date.now() - prev.lastFailureAt > WINDOW_MS;
  const next: VeoOutageState = {
    consecutiveFailures: (stale ? 0 : prev.consecutiveFailures) + 1,
    lastFailureAt: Date.now(),
    lastSuccessAt: prev.lastSuccessAt,
    lastFailMsg: failMsg ?? prev.lastFailMsg,
  };
  save(next);
  console.warn("[veo:outage] failure recorded", {
    consecutiveFailures: next.consecutiveFailures,
    degraded: next.consecutiveFailures >= FAIL_THRESHOLD,
  });
  return next;
}

export function recordVeoSuccess(): VeoOutageState {
  const prev = load();
  if (prev.consecutiveFailures > 0) {
    console.log("[veo:outage] cleared after success");
  }
  const next: VeoOutageState = {
    consecutiveFailures: 0,
    lastFailureAt: prev.lastFailureAt,
    lastSuccessAt: Date.now(),
    lastFailMsg: null,
  };
  save(next);
  return next;
}

export function veoOutageState(): VeoOutageState {
  return { ...load() };
}

/** Veo has failed repeatedly and recently — don't submit more Veo jobs. */
export function isVeoDegraded(): boolean {
  const s = load();
  if (s.consecutiveFailures < FAIL_THRESHOLD) return false;
  if (s.lastFailureAt === null) return false;
  return Date.now() - s.lastFailureAt <= WINDOW_MS;
}

/**
 * Model used while Veo is down. Seedance 2 Fast is the closest match that is
 * verified working: prompt + first/last frame + 9:16 + 720p.
 */
export const VEO_FALLBACK_MODEL_ID = "seedance-2-fast";

export const VEO_FALLBACK_NOTICE =
  "Veo 3.1 is failing upstream on kie right now (every job returns \"Internal Error\"), "
  + "so this was generated with Seedance 2.0 Fast using the same prompt and frames.";
