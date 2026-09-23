"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { isStoppedErrorMessage } from "@/lib/stopJob";

type GenerationRow = {
  status?: string;
  progress_phase?: string | null;
  video_url?: string | null;
  image_url?: string | null;
  image_urls?: string[] | null;
  error_msg?: string | null;
};

type TerminalPayload =
  | { status: "done"; videoUrl?: string; imageUrl?: string; imageUrls?: string[] }
  | { status: "error"; error: string };

export type GenerationSubscriptionHandlers = {
  onTerminal: (payload: TerminalPayload) => void;
  onPhase?: (phase: string) => void;
};

/** Subscribe to `generations` row updates for faster UI than poll-only. Guest mode: no-op. */
export function useGenerationSubscription(
  taskId: string | undefined,
  onTerminalOrHandlers: ((payload: TerminalPayload) => void) | GenerationSubscriptionHandlers,
): void {
  const handlers: GenerationSubscriptionHandlers =
    typeof onTerminalOrHandlers === "function"
      ? { onTerminal: onTerminalOrHandlers }
      : onTerminalOrHandlers;

  useEffect(() => {
    if (!taskId) return;
    if (process.env.NEXT_PUBLIC_GUEST_MODE === "true") return;

    const supabase = createClient();
    const channel = supabase
      .channel(`generation:${taskId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "generations",
          filter: `task_id=eq.${taskId}`,
        },
        (payload) => {
          const row = payload.new as GenerationRow;
          if (row.status === "pending" && row.progress_phase && handlers.onPhase) {
            handlers.onPhase(row.progress_phase);
          }
          if (row.status === "done") {
            handlers.onTerminal({
              status: "done",
              videoUrl: row.video_url ?? undefined,
              imageUrl: row.image_url ?? undefined,
              imageUrls: row.image_urls ?? undefined,
            });
          } else if (row.status === "error") {
            const err = row.error_msg ?? "Generation failed";
            if (isStoppedErrorMessage(err)) return;
            handlers.onTerminal({ status: "error", error: err });
          }
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [taskId, handlers.onTerminal, handlers.onPhase]);
}
