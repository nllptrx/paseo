export const tasksQueryBaseKey = ["tasks-snapshot"] as const;

export function tasksQueryKey(serverId: string) {
  return [...tasksQueryBaseKey, serverId] as const;
}

export const boardFeedQueryBaseKey = ["board-feed"] as const;

export function boardFeedQueryKey(serverId: string, projectId: string) {
  return [...boardFeedQueryBaseKey, serverId, projectId] as const;
}
