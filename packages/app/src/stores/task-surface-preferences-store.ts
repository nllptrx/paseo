import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { TaskPriority, TaskStatus } from "@getpaseo/protocol/tasks/types";
import type { TaskSort } from "@/tasks/task-views";

export type TaskSurfaceView = "kanban" | "tasks";

export interface TaskSurfacePreferences {
  view: TaskSurfaceView;
  query: string;
  statuses: TaskStatus[];
  priorities: TaskPriority[];
  labelNames: string[];
  sort: TaskSort;
  scrollOffset: number;
}

export const DEFAULT_TASK_SURFACE_PREFERENCES: TaskSurfacePreferences = {
  view: "kanban",
  query: "",
  statuses: [],
  priorities: [],
  labelNames: [],
  sort: "manual",
  scrollOffset: 0,
};

interface TaskSurfacePreferencesState {
  byScope: Record<string, TaskSurfacePreferences | undefined>;
  patchScope: (scope: string, patch: Partial<TaskSurfacePreferences>) => void;
  clearFilters: (scope: string) => void;
}

export const useTaskSurfacePreferencesStore = create<TaskSurfacePreferencesState>()(
  persist(
    (set) => ({
      byScope: {},
      patchScope: (scope, patch) =>
        set((state) => ({
          byScope: {
            ...state.byScope,
            [scope]: {
              ...(state.byScope[scope] ?? DEFAULT_TASK_SURFACE_PREFERENCES),
              ...patch,
            },
          },
        })),
      clearFilters: (scope) =>
        set((state) => ({
          byScope: {
            ...state.byScope,
            [scope]: {
              ...(state.byScope[scope] ?? DEFAULT_TASK_SURFACE_PREFERENCES),
              query: "",
              statuses: [],
              priorities: [],
              labelNames: [],
            },
          },
        })),
    }),
    {
      name: "task-surface-preferences",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
