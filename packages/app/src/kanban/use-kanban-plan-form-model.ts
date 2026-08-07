import { useEffect, useState } from "react";
import {
  openKanbanPlanForm,
  type KanbanPlanFormModel,
  type KanbanPlanFormSnapshot,
} from "./kanban-plan-form-model";
import { useKanbanAvailableProviders } from "./use-kanban-available-providers";

export function useKanbanPlanFormModel(snapshot: KanbanPlanFormSnapshot): KanbanPlanFormModel {
  const [model] = useState(() => openKanbanPlanForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  const { providers } = useKanbanAvailableProviders(snapshot.serverId);

  useEffect(() => {
    if (!providers) {
      return;
    }
    model.applyProviderSnapshot(snapshot.serverId, providers);
  }, [model, providers, snapshot.serverId]);

  return model;
}
