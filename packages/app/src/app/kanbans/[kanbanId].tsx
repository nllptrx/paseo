import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KanbanBoardScreen } from "@/screens/kanban-board-screen";

export default function KanbanBoardRoute() {
  const { kanbanId } = useLocalSearchParams<{ kanbanId: string }>();
  return (
    <HostRouteBootstrapBoundary>
      <KanbanBoardScreen kanbanId={kanbanId} />
    </HostRouteBootstrapBoundary>
  );
}
