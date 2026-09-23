import { fetchJobStatus } from "@/lib/fetchJobStatus";
import { isPollExpired, pollDelayMs } from "@/lib/jobPollSchedule";
import { waitOrVisible } from "@/lib/waitOrVisible";
import { isJobAborted } from "@/lib/abortedJobs";
import { isStoppedErrorMessage } from "@/lib/stopJob";

export type PollJobHandlers = {
  onPhase?: (phase: string) => void;
  onDone: (payload: { videoUrl?: string; imageUrl?: string }) => void;
  onError: (message: string) => void;
};

/** Poll until terminal state or 15 min timeout. */
export async function pollJobUntilDone(taskId: string, handlers: PollJobHandlers): Promise<void> {
  const startedAt = Date.now();
  let attempt = 0;

  while (!isPollExpired(startedAt)) {
    if (isJobAborted(taskId)) return;
    if (attempt > 0) await waitOrVisible(pollDelayMs(Date.now() - startedAt));
    attempt++;

    if (isJobAborted(taskId)) return;

    const result = await fetchJobStatus(taskId);
    if (result.kind === "fatal") {
      handlers.onError(result.error);
      return;
    }
    if (result.kind === "retry") continue;

    const { payload } = result;
    if (payload.status === "done") {
      handlers.onDone({ videoUrl: payload.videoUrl, imageUrl: payload.imageUrl });
      return;
    }
    if (payload.status === "error") {
      if (isStoppedErrorMessage(payload.error) || isJobAborted(taskId)) return;
      handlers.onError(payload.error ?? "Generation failed");
      return;
    }
    if (payload.status === "not_found") {
      handlers.onError("Job expired or unknown");
      return;
    }
    if (payload.phase) handlers.onPhase?.(payload.phase);
  }

  handlers.onError("Timed out");
}
