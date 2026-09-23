import { abortJob } from "@/lib/abortedJobs";

/** Stop polling locally and mark the job stopped on the server. */
export async function cancelJobOnServer(taskId: string, token?: string | null): Promise<void> {
  abortJob(taskId);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    await fetch("/api/cancel-job", {
      method: "POST",
      headers,
      credentials: "include",
      body: JSON.stringify({ taskId }),
    });
  } catch {
    /* UI already aborted poll */
  }
}
