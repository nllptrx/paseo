export const prPaneTimelineQueryKind = "prPaneTimeline";

export function prPaneTimelineQueryKey({
  serverId,
  cwd,
  prNumber,
}: {
  serverId: string;
  cwd: string;
  prNumber: number | null;
}) {
  return [prPaneTimelineQueryKind, serverId, cwd, prNumber] as const;
}

export const prPanePipelineQueryKind = "prPanePipeline";

export function prPanePipelineQueryKey({
  serverId,
  cwd,
  pipelineId,
}: {
  serverId: string;
  cwd: string;
  pipelineId: number | null;
}) {
  return [prPanePipelineQueryKind, serverId, cwd, pipelineId] as const;
}
