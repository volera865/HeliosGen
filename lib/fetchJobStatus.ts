export type JobStatusPayload = {
  status: string;
  phase?: string;
  videoUrl?: string;
  imageUrl?: string;
  imageUrls?: string[];
  error?: string;
};

export type JobStatusFetchResult =
  | { kind: "ok"; payload: JobStatusPayload }
  | { kind: "retry" }
  | { kind: "fatal"; error: string };

/** Client-side job-status fetch with consistent 404 / auth handling. */
export async function fetchJobStatus(taskId: string): Promise<JobStatusFetchResult> {
  try {
    const res = await fetch(`/api/job-status?taskId=${encodeURIComponent(taskId)}`);
    if (res.status === 404) {
      return { kind: "ok", payload: { status: "not_found" } };
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { kind: "fatal", error: body.error ?? `Job status failed (${res.status})` };
    }
    if (!res.ok) return { kind: "retry" };
    const payload = await res.json() as JobStatusPayload;
    return { kind: "ok", payload };
  } catch {
    return { kind: "retry" };
  }
}
