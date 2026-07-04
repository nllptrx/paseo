/**
 * Neutral check/pipeline status mapping shared by the PR-pane data builder, the
 * forge native-data contributions, and the pane render. Kept forge-agnostic: a
 * forge maps its raw CI/pipeline strings onto this frozen union.
 */
export type CheckStatus = "success" | "failure" | "pending" | "skipped";

export function mapCheckStatus(status: string): CheckStatus {
  if (
    status === "success" ||
    status === "failure" ||
    status === "pending" ||
    status === "skipped"
  ) {
    return status;
  }
  if (status === "cancelled") {
    return "skipped";
  }
  return "pending";
}

export function mapPipelineStatus(status: string): CheckStatus {
  switch (status) {
    case "success":
    case "passed":
      return "success";
    case "failed":
      return "failure";
    case "running":
    case "pending":
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
      return "pending";
    case "canceled":
    case "cancelled":
    case "skipped":
    case "manual":
      return "skipped";
    default:
      return "pending";
  }
}

export function isPipelineActiveStatus(status: string): boolean {
  return (
    status === "running" ||
    status === "pending" ||
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "scheduled"
  );
}
