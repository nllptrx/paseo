import { useCallback, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanPlan } from "@getpaseo/protocol/kanban/types";
import { Button } from "@/components/ui/button";
import type { DerivedColumnKey } from "@/kanban/derive-board";
import { KanbanCard, type KanbanCardAction } from "./kanban-card";

/** Long-lived boards accumulate finished plans; render a page of them so opening
 * the board stays cheap, and let the reader ask for the rest. */
const DONE_RENDER_CAP = 30;

const COLUMN_LABEL_KEYS: Record<DerivedColumnKey, string> = {
  draft: "kanban.column.draft",
  inProgress: "kanban.column.inProgress",
  done: "kanban.column.done",
};

export interface KanbanColumnProps {
  serverId: string;
  columnKey: DerivedColumnKey;
  plans: KanbanPlan[];
  onOpenPlan: (planId: string) => void;
  planActions: (plan: KanbanPlan) => KanbanCardAction[];
  /** Only the draft column offers one: the other two are reached by running work. */
  onCreatePlan?: () => void;
  /** True while a dragged draft would land here, so the column can say so. */
  isRunTarget?: boolean;
  isOver?: boolean;
  showAllDone?: boolean;
  onShowAllDone?: () => void;
  /** Lets the web board wrap each card in a sortable without forking the column. */
  renderCard?: (plan: KanbanPlan, card: ReactNode) => ReactNode;
  /** Registers the column body as a drop target on web. */
  bodyRef?: (element: never) => void;
}

export function KanbanColumn({
  serverId,
  columnKey,
  plans,
  onOpenPlan,
  planActions,
  onCreatePlan,
  isRunTarget = false,
  isOver = false,
  showAllDone = false,
  onShowAllDone,
  renderCard,
  bodyRef,
}: KanbanColumnProps): ReactElement {
  const { t } = useTranslation();

  const visiblePlans =
    columnKey === "done" && !showAllDone && plans.length > DONE_RENDER_CAP
      ? plans.slice(0, DONE_RENDER_CAP)
      : plans;
  const hiddenCount = plans.length - visiblePlans.length;

  const handleOpenPlan = useCallback((planId: string) => () => onOpenPlan(planId), [onOpenPlan]);

  return (
    <View style={styles.column} testID={`kanban-column-${columnKey}`}>
      <View style={styles.header}>
        <Text style={styles.title}>{t(COLUMN_LABEL_KEYS[columnKey])}</Text>
        <Text style={styles.count}>{plans.length}</Text>
        {isRunTarget ? <Text style={styles.dropHint}>{t("kanban.column.dropToRun")}</Text> : null}
        {onCreatePlan ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={onCreatePlan}
            style={styles.addButton}
            accessibilityLabel={t("kanban.column.addPlan")}
            testID={`kanban-column-add-${columnKey}`}
          >
            {t("kanban.column.addPlan")}
          </Button>
        ) : null}
      </View>

      <View
        ref={bodyRef as never}
        style={[styles.body, isRunTarget && styles.bodyRunTarget, isOver && styles.bodyOver]}
        testID={`kanban-column-body-${columnKey}`}
      >
        {visiblePlans.map((plan) => {
          const card = (
            <KanbanCard
              serverId={serverId}
              plan={plan}
              onPress={handleOpenPlan(plan.id)}
              actions={planActions(plan)}
            />
          );
          return (
            <View key={plan.id} style={styles.cardSlot}>
              {renderCard ? renderCard(plan, card) : card}
            </View>
          );
        })}

        {plans.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{t("kanban.column.empty")}</Text>
          </View>
        ) : null}

        {hiddenCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={onShowAllDone}
            testID={`kanban-column-show-more-${columnKey}`}
          >
            {t("kanban.column.showMore", { count: hiddenCount })}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    flex: 1,
    minWidth: 264,
    maxWidth: 360,
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1.5],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  dropHint: {
    marginLeft: "auto",
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.xs,
  },
  addButton: {
    marginLeft: "auto",
  },
  /**
   * The column body is the drop target, so it has to read as a surface even when
   * empty — an unbounded stack of cards gives a drag nothing to aim at.
   */
  body: {
    flex: 1,
    minHeight: 96,
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
  },
  // Highlighted only while the drop would actually do something.
  bodyRunTarget: {
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    padding: theme.spacing[1] - 1,
  },
  bodyOver: {
    borderColor: theme.colors.statusSuccess,
  },
  cardSlot: {
    width: "100%",
  },
  empty: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
