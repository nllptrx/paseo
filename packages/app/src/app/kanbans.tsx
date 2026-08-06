import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { KanbansScreen } from "@/screens/kanbans-screen";

export default function KanbansRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <KanbansScreen />
    </HostRouteBootstrapBoundary>
  );
}
