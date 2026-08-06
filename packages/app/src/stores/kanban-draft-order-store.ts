import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const KANBAN_DRAFT_ORDER_STORAGE_KEY = "kanban-draft-order";

interface KanbanDraftOrderState {
  /** Plan ids per kanban, most-wanted first. Absent kanbans fall back to recency. */
  orderByKanbanId: Record<string, string[]>;
  setDraftOrder: (kanbanId: string, order: string[]) => void;
}

/**
 * Where the user wants their unstarted plans is a view preference, not execution
 * state, so it stays on the client next to the other sidebar/board preferences.
 * Every other column orders itself by what actually ran, which no device-local
 * ordering should be able to contradict.
 */
export const useKanbanDraftOrderStore = create<KanbanDraftOrderState>()(
  persist(
    (set) => ({
      orderByKanbanId: {},
      setDraftOrder: (kanbanId, order) =>
        set((state) => ({ orderByKanbanId: { ...state.orderByKanbanId, [kanbanId]: order } })),
    }),
    {
      name: KANBAN_DRAFT_ORDER_STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ orderByKanbanId: state.orderByKanbanId }),
    },
  ),
);

const EMPTY_ORDER: string[] = [];

export function useKanbanDraftOrder(kanbanId: string): string[] {
  return useKanbanDraftOrderStore((state) => state.orderByKanbanId[kanbanId] ?? EMPTY_ORDER);
}
