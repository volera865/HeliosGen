const aborted = new Set<string>();

export function abortJob(taskId: string): void {
  aborted.add(taskId);
}

export function isJobAborted(taskId: string): boolean {
  return aborted.has(taskId);
}

export function clearJobAborted(taskId: string): void {
  aborted.delete(taskId);
}
