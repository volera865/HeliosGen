"use client";

import { useGenerationSubscription } from "@/lib/useGenerationSubscription";

type Props = {
  taskId: string;
  onDone: () => void;
  onError: (message: string) => void;
  onPhase?: (phase: string) => void;
};

/** Realtime terminal + phase updates for a gallery pending tile (poll remains as backup). */
export function PendingGenRealtimeBridge({ taskId, onDone, onError, onPhase }: Props) {
  useGenerationSubscription(taskId, {
    onTerminal: (payload) => {
      if (payload.status === "done") onDone();
      else onError(payload.error);
    },
    onPhase,
  });
  return null;
}
