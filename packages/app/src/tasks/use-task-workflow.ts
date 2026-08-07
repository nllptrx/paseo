import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Step } from "@getpaseo/protocol/tasks/workflow";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { tasksQueryKey } from "@/tasks/task-query-keys";

export type TaskStepAction = "run" | "retry" | "skip" | "cancel";

/** What the latest run says about a step, which is all a reader needs to know
 * whether it can be started, retried, or is already going. */
export function resolveStepState(step: Step): {
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  actions: TaskStepAction[];
} {
  const latest = step.runs.at(-1);
  if (!latest) {
    return { status: "pending", actions: ["run", "skip"] };
  }
  if (latest.status === "running") {
    return { status: "running", actions: ["cancel"] };
  }
  if (latest.status === "succeeded") {
    return { status: "succeeded", actions: [] };
  }
  if (latest.status === "skipped") {
    return { status: "skipped", actions: [] };
  }
  return { status: "failed", actions: ["retry", "skip"] };
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
