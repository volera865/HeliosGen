/**
 * Correlated Veo diagnostics for Internal Error investigations.
 * Logs are intentionally verbose; never prints secrets or full signed query strings.
 */

import { veoUrlLog } from "@/lib/veoClientPayload";

export type VeoDiagSnapshot = {
  source?: string;
  model?: string;
  apiId?: string;
  veoMode?: string;
  generationType?: string;
  aspectRatio?: string;
  resolution?: string;
  promptLen?: number;
  promptHead?: string;
  nImageUrls?: number;
  imageHosts?: string[];
  startHost?: string;
  endHost?: string;
  sameStartEnd?: boolean;
  probe?: Array<{ host: string; ok: boolean; status?: number; method?: string }>;
  callBackHost?: string;
  createdAt: string;
};

const byTask = new Map<string, VeoDiagSnapshot>();

export function veoDiagLog(stage: string, data: Record<string, unknown>): void {
  try {
    console.log(`[veo:diag:${stage}]`, JSON.stringify(data));
  } catch {
    console.log(`[veo:diag:${stage}]`, data);
  }
}

export function veoDiagRemember(taskId: string, snap: Omit<VeoDiagSnapshot, "createdAt"> & { createdAt?: string }): void {
  const full: VeoDiagSnapshot = {
    ...snap,
    createdAt: snap.createdAt ?? new Date().toISOString(),
  };
  byTask.set(taskId, full);
  // Bound memory
  if (byTask.size > 200) {
    const first = byTask.keys().next().value;
    if (first) byTask.delete(first);
  }
  veoDiagLog("remember", { taskId: taskId.slice(0, 16), ...full });
}

export function veoDiagLookup(taskId: string): VeoDiagSnapshot | undefined {
  return byTask.get(taskId);
}

export function veoDiagFail(taskId: string, extra: Record<string, unknown>): void {
  const snap = byTask.get(taskId);
  veoDiagLog("FAIL", {
    taskId: String(taskId).slice(0, 16),
    ...extra,
    remembered: snap ?? null,
  });
}

export function promptHead(prompt: string | undefined, n = 80): string {
  const p = (prompt ?? "").replace(/\s+/g, " ").trim();
  return p.length <= n ? p : `${p.slice(0, n)}…`;
}

export function hostsEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).href.split("?")[0] === new URL(b).href.split("?")[0];
  } catch {
    return a === b;
  }
}

export { veoUrlLog };
