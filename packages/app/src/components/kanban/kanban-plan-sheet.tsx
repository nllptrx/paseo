import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanPlan, NestedPlan, Step, StoredKanban } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { deriveBoard } from "@/kanban/derive-board";
import { resolveKanbanPlan } from "@/kanban/plan-lookup";
import { resolveNextRunnableStepId } from "@/kanban/run-plan";
import { KanbanBoard } from "./kanban-board";
import type { KanbanCardAction } from "./kanban-card";
import { KanbanPlanFormSheet } from "./kanban-plan-form-sheet";

export interface KanbanPlanSheetProps {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  planId: string;
  kanban: StoredKanban;
  visible: boolean;
  onClose: () => void;
}

const NO_DRAFT_ORDER: string[] = [];
const noopReorder = () => undefined;

function latestRun(step: Step) {
  return step.runs.at(-1) ?? null;
}

function StepRow({
  serverId,
  kanbanId,
  parentPlanId,
  planId,
  step,
}: {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  planId: string;
  step: Step;
}): ReactElement {
  const { t } = useTranslation();
  const { runStep, retryStep, skipStep, cancelStep } = useKanbanMutations({ serverId });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const run = latestRun(step);
  const status = run?.status ?? null;

  const actionInput = { kanbanId, parentPlanId, planId, stepId: step.id };

  const withPending = useCallback(
    (action: string, perform: () => Promise<void>) => async () => {
      setPendingAction(action);
      try {
        await perform();
      } finally {
        setPendingAction(null);
      }
    },
    [],
  );

  const handleRun = withPending("run", () => runStep(actionInput));
  const handleRetry = withPending("retry", () => retryStep(actionInput));
  const handleSkip = withPending("skip", () => skipStep(actionInput));
  const handleCancel = withPending("cancel", () => cancelStep(actionInput));

  const canRun = status !== "running";
  const canRetry = status === "failed" || status === "interrupted" || status === "canceled";
  const canSkip = status !== "running" && status !== "succeeded" && status !== "skipped";
  const canCancel = status === "running";

  return (
    <View style={styles.stepRow} testID={`kanban-step-${step.id}`}>
      <View style={styles.stepHeader}>
        <Text style={styles.stepName}>{step.name}</Text>
        <Text style={styles.stepStatus}>
          {status ? t(`kanban.step.status.${status}`) : t("kanban.step.status.notRun")}
        </Text>
      </View>
      <View style={styles.stepActions}>
        <Button
          variant="outline"
          size="sm"
          onPress={handleRun}
          disabled={!canRun || pendingAction !== null}
          loading={pendingAction === "run"}
          testID={`kanban-step-run-${step.id}`}
        >
          {t("kanban.step.actions.run")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={handleRetry}
          disabled={!canRetry || pendingAction !== null}
          loading={pendingAction === "retry"}
          testID={`kanban-step-retry-${step.id}`}
        >
          {t("kanban.step.actions.retry")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleSkip}
          disabled={!canSkip || pendingAction !== null}
          loading={pendingAction === "skip"}
          testID={`kanban-step-skip-${step.id}`}
        >
          {t("kanban.step.actions.skip")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onPress={handleCancel}
          disabled={!canCancel || pendingAction !== null}
          loading={pendingAction === "cancel"}
          testID={`kanban-step-cancel-${step.id}`}
        >
          {t("kanban.step.actions.cancel")}
        </Button>
      </View>
    </View>
  );
}

/**
 * The Plan sheet: a workflow plan shows its steps with run/retry/skip/cancel;
 * a nested-kanban plan shows its child board and drills a level deeper via a
 * local focus stack (protocol caps nesting at one level, so the stack never
 * grows past two entries).
 */
export function KanbanPlanSheet({
  serverId,
  kanbanId,
  parentPlanId,
  planId,
  kanban,
  visible,
  onClose,
}: KanbanPlanSheetProps): ReactElement | null {
  const { t } = useTranslation();
  const { runStep } = useKanbanMutations({ serverId });
  const toast = useToast();
  const [focusedChildId, setFocusedChildId] = useState<string | null>(null);

  const [isCreatingChild, setIsCreatingChild] = useState(false);

  const plan = resolveKanbanPlan(kanban, parentPlanId, planId);

  const childPlan = useMemo(() => {
    if (!plan || plan.body.type !== "nested_kanban" || !focusedChildId) {
      return null;
    }
    return plan.body.plans[focusedChildId] ?? null;
  }, [plan, focusedChildId]);

  const handleOpenChild = useCallback((childId: string) => setFocusedChildId(childId), []);
  const handleBackToParent = useCallback(() => setFocusedChildId(null), []);
  const handleCloseCreatePlan = useCallback(() => setIsCreatingChild(false), []);

  const handleRunChild = useCallback(
    (childId: string) => {
      const child = plan?.body.type === "nested_kanban" ? plan.body.plans[childId] : null;
      const stepId = child ? resolveNextRunnableStepId(child) : null;
      if (stepId === null) {
        return;
      }
      void runStep({ kanbanId, parentPlanId: planId, planId: childId, stepId });
    },
    [kanbanId, plan, planId, runStep],
  );

  const handleRejectedDrop = useCallback(() => {
    toast.show(t("kanban.column.doneIsDerivedDescription"));
  }, [t, toast]);

  const nestedPlanActions = useCallback(
    (child: KanbanPlan): KanbanCardAction[] =>
      resolveNextRunnableStepId(child) === null
        ? []
        : [
            {
              key: "run",
              label: t("kanban.step.actions.run"),
              onSelect: () => handleRunChild(child.id),
            },
          ],
    [handleRunChild, t],
  );

  const handleOpenCreateChild = useCallback(() => {
    setIsCreatingChild(plan?.body.type === "nested_kanban");
  }, [plan]);

  const activePlan: KanbanPlan | NestedPlan | null = childPlan ?? plan;

  const header = useMemo(() => {
    if (childPlan && plan) {
      return {
        title: childPlan.title,
        subtitle: plan.title,
        back: { onPress: handleBackToParent, label: plan.title },
      };
    }
    return { title: plan?.title ?? "" };
  }, [childPlan, plan, handleBackToParent]);

  const nestedBoard = useMemo(() => {
    if (!activePlan || activePlan.body.type !== "nested_kanban") {
      return null;
    }
    // Children are workflow-only, so the same derivation the top-level board uses
    // applies unchanged; a nested board has no draft order of its own.
    return deriveBoard(
      { ...kanban, id: activePlan.id, plans: activePlan.body.plans },
      NO_DRAFT_ORDER,
    );
  }, [activePlan, kanban]);

  if (!plan || !activePlan) {
    return null;
  }

  let bodyContent: ReactElement | null;
  if (activePlan.body.type === "workflow") {
    bodyContent = (
      <View style={styles.steps}>
        {activePlan.body.steps.map((step) => (
          <StepRow
            key={step.id}
            serverId={serverId}
            kanbanId={kanbanId}
            parentPlanId={childPlan ? planId : parentPlanId}
            planId={activePlan.id}
            step={step}
          />
        ))}
      </View>
    );
  } else if (nestedBoard) {
    bodyContent = (
      <KanbanBoard
        serverId={serverId}
        board={nestedBoard}
        onOpenPlan={handleOpenChild}
        onCreatePlan={handleOpenCreateChild}
        planActions={nestedPlanActions}
        onRunPlan={handleRunChild}
        onReorderDrafts={noopReorder}
        onRejectedDrop={handleRejectedDrop}
      />
    );
  } else {
    bodyContent = null;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="kanban-plan-sheet"
    >
      {activePlan.description ? (
        <Text style={styles.description}>{activePlan.description}</Text>
      ) : null}
      {bodyContent}
      {activePlan.body.type === "workflow" && activePlan.body.steps.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t("kanban.planSheet.noSteps")}</Text>
        </View>
      ) : null}
      {isCreatingChild ? (
        <KanbanPlanFormSheet
          serverId={serverId}
          kanbanId={kanbanId}
          parentPlanId={activePlan.id}
          visible
          onClose={handleCloseCreatePlan}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  steps: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  stepRow: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
  },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  stepStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  empty: {
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
