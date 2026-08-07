export const tasksQueryBaseKey = ["tasks-snapshot"] as const;

export function tasksQueryKey(serverId: string) {
  return [...tasksQueryBaseKey, serverId] as const;
}
