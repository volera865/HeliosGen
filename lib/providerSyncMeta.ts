/** Last Kie recordInfo snapshot for a job (per server instance). */
export type ProviderSyncSnapshot = {
  providerState: string;
  lastSyncOk: boolean;
};

const cache = new Map<string, ProviderSyncSnapshot>();

export function setProviderSyncMeta(taskId: string, snap: ProviderSyncSnapshot): void {
  cache.set(taskId, snap);
}

export function getProviderSyncMeta(taskId: string): ProviderSyncSnapshot | undefined {
  return cache.get(taskId);
}

export function withProviderSyncMeta<T extends Record<string, unknown>>(taskId: string, body: T): T {
  const snap = getProviderSyncMeta(taskId);
  if (!snap) return body;
  return { ...body, providerState: snap.providerState, lastSyncOk: snap.lastSyncOk };
}
