export const GITLAB_ACTIVE_PIPELINE_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "scheduled",
] as const;

export type GitLabActivePipelineStatus = (typeof GITLAB_ACTIVE_PIPELINE_STATUSES)[number];
