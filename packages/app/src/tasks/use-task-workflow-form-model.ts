import { useEffect, useState } from "react";
import { useTaskAvailableProviders } from "@/tasks/use-task-available-providers";
import {
  openTaskWorkflowForm,
  type TaskWorkflowFormModel,
  type TaskWorkflowFormSnapshot,
} from "./task-workflow-form-model";

export function useTaskWorkflowFormModel(
  snapshot: TaskWorkflowFormSnapshot,
): TaskWorkflowFormModel {
  const [model] = useState(() => openTaskWorkflowForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  const { providers } = useTaskAvailableProviders(snapshot.serverId);

  useEffect(() => {
    if (!providers) {
      return;
    }
    model.applyProviderSnapshot(snapshot.serverId, providers);
  }, [model, providers, snapshot.serverId]);

  return model;
}
