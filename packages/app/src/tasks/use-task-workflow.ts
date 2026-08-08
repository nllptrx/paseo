import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Step } from "@getpaseo/protocol/tasks/workflow";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { tasksQueryKey } from "@/tasks/task-query-keys";

export type TaskStepAction = "run" | "retry" | "skip" | "cancel";

export type TaskStepDisplayStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "canceled"
  | "skipped";

const STEP_DISPLAY_STATES: Record<TaskStepDisplayStatus, { actions: TaskStepAction[] }> = {
  pending: { actions: ["run", "skip"] },
  // Waiting for a slot, not stuck: offering Retry would restart something that
  // has not started, and cancel is the only thing there is to want.
  queued: { actions: ["cancel"] },
  running: { actions: ["cancel"] },
  succeeded: { actions: [] },
  // Named apart from a failure on purpose: nothing went wrong, the daemon went
  // away, and the answer is to run it again rather than to read an error.
  interrupted: { actions: ["retry", "skip"] },
  canceled: { actions: ["retry", "skip"] },
  failed: { actions: ["retry", "skip"] },
  skipped: { actions: [] },
};

/**
 * What the latest run says about a step: whether it can be started, retried, or
 * is already going, and why it stopped when it did.
 */
export function resolveStepState(step: Step): {
  status: TaskStepDisplayStatus;
  actions: TaskStepAction[];
  /** What the run recorded when it ended — the failing command's output, the
   * timeout, the missing evidence. Null while nothing has gone wrong. */
  error: string | null;
} {
  const latest = step.runs.at(-1);
  if (!latest) {
    return { status: "pending", ...STEP_DISPLAY_STATES.pending, error: null };
  }
  const status: TaskStepDisplayStatus = latest.status;
  return { status, ...STEP_DISPLAY_STATES[status], error: latest.error ?? null };
}

const STEP_ACTION_SENDERS: Record<
  TaskStepAction,
  (
    client: DaemonClient,
    target: { taskId: string; stepId: string },
  ) => Promise<{ error: string | null }>
> = {
  run: (client, target) => client.tasksStepRun(target),
  retry: (client, target) => client.tasksStepRetry(target),
  skip: (client, target) => client.tasksStepSkip(target),
  cancel: (client, target) => client.tasksStepCancel(target),
};

export function useTaskStepActions(serverId: string): {
  act: (input: { taskId: string; stepId: string; action: TaskStepAction }) => Promise<void>;
  isActing: boolean;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: tasksQueryKey(serverId) });
  }, [queryClient, serverId]);

  const mutation = useMutation({
    mutationFn: async (input: { taskId: string; stepId: string; action: TaskStepAction }) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const target = { taskId: input.taskId, stepId: input.stepId };
      const send = STEP_ACTION_SENDERS[input.action];
      const payload = await send(client, target);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  return {
    act: async (input) => {
      await mutation.mutateAsync(input);
    },
    isActing: mutation.isPending,
  };
}
