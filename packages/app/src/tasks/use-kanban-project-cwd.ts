import { useMemo } from "react";
import { useProjects } from "@/hooks/use-projects";

/** Provider capabilities can depend on the checkout. Kanban execution forms
 * resolve their linked Paseo project to the host-local repository root before
 * asking which modes and features are available. */
export function useKanbanProjectCwd(
  serverId: string,
  paseoProjectId: string | null | undefined,
): string | null {
  const { projects } = useProjects();
  return useMemo(() => {
    if (!paseoProjectId) return null;
    for (const project of projects) {
      const host = project.hosts.find(
        (entry) => entry.serverId === serverId && entry.projectId === paseoProjectId,
      );
      if (host) return host.repoRoot;
    }
    return null;
  }, [paseoProjectId, projects, serverId]);
}
