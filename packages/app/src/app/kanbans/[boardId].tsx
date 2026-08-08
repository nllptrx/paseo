import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KanbanBoardScreen } from "@/screens/kanban-board-screen";

export default function KanbanBoardRoute() {
  const { boardId, task } = useLocalSearchParams<{ boardId: string; task?: string }>();
  return (
    <HostRouteBootstrapBoundary>
      <KanbanBoardScreen boardId={boardId} initialTaskId={task ?? null} />
    </HostRouteBootstrapBoundary>
  );
}
