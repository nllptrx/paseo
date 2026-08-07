import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KanbanPlan, NestedPlan, Step, StoredKanban } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { getProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { useKanbanMutations } from "@/hooks/use-kanban-mutations";
import { deriveBoard } from "@/kanban/derive-board";
import { resolveKanbanPlan } from "@/kanban/plan-lookup";
import { deriveWorkflowStepProgress } from "@/kanban/plan-status";
import { resolveNextRunnableStepId } from "@/kanban/run-plan";
import {
  STEP_TRIGGER_LABEL_KEYS,
  STEP_WORKSPACE_LABEL_KEYS,
  describeStepAgents,
  isStepGateOpen,
  resolveProviderLabel,
  resolveStepActions,
  resolveStepChatTarget,
  resolveStepRunHistory,
  resolveStepStatus,
  type StepActionKind,
} from "@/kanban/step-detail";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/time";
import { KanbanBoard } from "./kanban-board";
import type { KanbanCardAction } from "./kanban-card";
import { KanbanPlanFormSheet } from "./kanban-plan-form-sheet";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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

const ACTION_LABEL_KEYS: Record<StepActionKind, string> = {
  run: "kanban.step.actions.run",
  retry: "kanban.step.actions.retry",
  skip: "kanban.step.actions.skip",
  cancel: "kanban.step.actions.cancel",
};

function StepCard({
  serverId,
  kanbanId,
  parentPlanId,
  planId,
  steps,
  index,
  onOpenChat,
}: {
  serverId: string;
  kanbanId: string;
  parentPlanId: string | null;
  planId: string;
  steps: Step[];
  index: number;
  onOpenChat: (target: { workspaceId: string; agentId: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { runStep, retryStep, skipStep, cancelStep } = useKanbanMutations({ serverId });
  const [pendingAction, setPendingAction] = useState<StepActionKind | null>(null);
  const step = steps[index] as Step;
  const status = resolveStepStatus(step);
  const actions = resolveStepActions(steps, index);
  const chatTarget = resolveStepChatTarget(step);
  const agents = describeStepAgents(step);
  const history = resolveStepRunHistory(step);

  const perform = useCallback(
    (action: StepActionKind) => () => {
      const mutate = { run: runStep, retry: retryStep, skip: skipStep, cancel: cancelStep }[action];
      setPendingAction(action);
      void mutate({ kanbanId, parentPlanId, planId, stepId: step.id }).finally(() =>
        setPendingAction(null),
      );
    },
    [cancelStep, kanbanId, parentPlanId, planId, retryStep, runStep, skipStep, step.id],
  );

  const handleOpenChat = useCallback(() => {
    if (chatTarget) {
      onOpenChat(chatTarget);
    }
  }, [chatTarget, onOpenChat]);

  return (
    <View style={styles.stepRow} testID={`kanban-step-${step.id}`}>
      <View style={styles.stepHeader}>
        <Text style={styles.stepIndex}>{index + 1}</Text>
        <Text style={styles.stepName}>{step.name}</Text>
        <Text style={styles.stepStatus} testID={`kanban-step-status-${step.id}`}>
          {status ? t(`kanban.step.status.${status}`) : t("kanban.step.status.notRun")}
        </Text>
      </View>

      <View style={styles.agents}>
        {agents.map((agent) => (
          <View key={agent.key} style={styles.agent}>
            <ProviderGlyph provider={agent.provider} />
            <Text style={styles.agentText}>
              {resolveProviderLabel(agent.provider)}
              {" · "}
              {agent.model ?? t("kanban.planSheet.defaultModel")}
            </Text>
          </View>
        ))}
      </View>

      <Text style={styles.stepPrompt} numberOfLines={4}>
        {step.prompt}
      </Text>

      <Text style={styles.stepMeta}>
        {t(STEP_WORKSPACE_LABEL_KEYS[step.workspace.mode])}
        {" · "}
        {t(STEP_TRIGGER_LABEL_KEYS[step.trigger.type])}
      </Text>

      <View style={styles.runs}>
        {history.length === 0 ? (
          <Text style={styles.runEmpty}>{t("kanban.planSheet.noRuns")}</Text>
        ) : null}
        {history.map((entry) => (
          <StepRunRow
            key={entry.id}
            startedAt={entry.startedAt}
            endedAt={entry.endedAt}
            statusLabel={t(`kanban.step.status.${entry.status}`)}
            error={entry.error}
          />
        ))}
      </View>

      {!isStepGateOpen(steps, index) && status === null ? (
        <Text style={styles.stepGate}>{t("kanban.planSheet.gateBlocked")}</Text>
      ) : null}

      <View style={styles.stepActions}>
        {chatTarget ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedMessageSquare}
            onPress={handleOpenChat}
            testID={`kanban-step-chat-${step.id}`}
          >
            {t("kanban.planSheet.openChat")}
          </Button>
        ) : null}
        {actions.map((action) => (
          <Button
            key={action}
            variant={action === "run" || action === "retry" ? "outline" : "ghost"}
            size="sm"
            onPress={perform(action)}
            disabled={pendingAction !== null}
            loading={pendingAction === action}
            testID={`kanban-step-${action}-${step.id}`}
          >
            {t(ACTION_LABEL_KEYS[action])}
          </Button>
        ))}
      </View>
    </View>
  );
}

/** One attempt: when it started, how long it took, and why it stopped if it
 * went wrong. A failed run says nothing useful without its error. */
function StepRunRow({
  startedAt,
  endedAt,
  statusLabel,
  error,
}: {
  startedAt: string;
  endedAt: string | null;
  statusLabel: string;
  error: string | null;
}): ReactElement {
  const started = useMemo(() => new Date(startedAt), [startedAt]);
  const startedAgo = useCompactTimeAgo(started);
  const duration =
    endedAt === null ? null : formatDuration(new Date(endedAt).getTime() - started.getTime());

  return (
    <View style={styles.run}>
      <Text style={styles.runText}>
        {[statusLabel, startedAgo, duration].filter(Boolean).join(" · ")}
      </Text>
      {error ? <Text style={styles.runError}>{error}</Text> : null}
    </View>
  );
}

function ProviderGlyph({ provider }: { provider: string }): ReactElement {
  const Icon = getProviderIcon(provider);
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  return <ThemedIcon size={ICON_SIZE.xs} uniProps={mutedIconMapping} />;
}

/**
 * The Plan sheet: a workflow plan shows what each step sends, where it runs,
 * what it has already tried and how that went; a nested-kanban plan shows its
 * child board and drills a level deeper via a local focus stack (protocol caps
 * nesting at one level, so the stack never grows past two entries).
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

  /** The sheet sits over the board, and the chat is somewhere else entirely. */
  const handleOpenChat = useCallback(
    (target: { workspaceId: string; agentId: string }) => {
      onClose();
      navigateToWorkspace({
        serverId,
        workspaceId: target.workspaceId,
        target: { kind: "agent", agentId: target.agentId },
      });
    },
    [onClose, serverId],
  );

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

  const steps = activePlan.body.type === "workflow" ? activePlan.body.steps : [];
  const progress = deriveWorkflowStepProgress(steps);

  let bodyContent: ReactElement | null;
  if (activePlan.body.type === "workflow") {
    bodyContent = (
      <View style={styles.steps}>
        {steps.map((step, index) => (
          <StepCard
            key={step.id}
            serverId={serverId}
            kanbanId={kanbanId}
            parentPlanId={childPlan ? planId : parentPlanId}
            planId={activePlan.id}
            steps={steps}
            index={index}
            onOpenChat={handleOpenChat}
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
      {activePlan.body.type === "workflow" && steps.length > 0 ? (
        <Text style={styles.summary}>
          {t("kanban.card.stepProgress", { done: progress.done, total: progress.total })}
        </Text>
      ) : null}
      {bodyContent}
      {activePlan.body.type === "workflow" && steps.length === 0 ? (
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
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
    gap: theme.spacing[2],
  },
  // Position in the workflow, which is what decides when the step can run.
  stepIndex: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    minWidth: 12,
  },
  stepName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  stepStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  agents: {
    gap: theme.spacing[1],
  },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  agentText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepPrompt: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  stepMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepGate: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontStyle: "italic",
  },
  runs: {
    gap: theme.spacing[1],
  },
  run: {
    gap: 2,
  },
  runText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  runError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  runEmpty: {
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
