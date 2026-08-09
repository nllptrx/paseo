import { useCallback } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KanbanBoardScreen } from "@/screens/kanban-board-screen";

export default function KanbanBoardRoute() {
  const { boardId, task } = useLocalSearchParams<{ boardId: string; task?: string }>();
  const router = useRouter();
  const handleInitialTaskHandled = useCallback(
    () => router.setParams({ task: undefined }),
    [router],
  );
  return (
    <HostRouteBootstrapBoundary>
      <KanbanBoardScreen
        boardId={boardId}
        initialTaskId={task ?? null}
        onInitialTaskHandled={handleInitialTaskHandled}
      />
    </HostRouteBootstrapBoundary>
  );
}
