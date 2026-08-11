import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { TaskLabel, TaskPriority, TaskStatus } from "@getpaseo/protocol/tasks/types";
import { TASK_STATUSES } from "@getpaseo/protocol/tasks/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  useDropdownMenuBack,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { IDENTITY_COLOR_NAMES, identityColor } from "@/styles/identity-colors";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveTaskDueDatePreset, type TaskDueDatePreset } from "@/tasks/task-due-date";
import { toErrorMessage } from "@/utils/error-messages";
import { TaskDueDateFormSheet } from "./task-due-date-form-sheet";
import { TASK_PRIORITY_LABEL_KEYS, TASK_STATUS_LABEL_KEYS } from "./task-board-parts";
import { TaskStatusDot } from "./task-list";

const TASK_PRIORITIES: readonly TaskPriority[] = ["none", "urgent", "high", "medium", "low"];

/**
 * The one property-chip look shared by the task detail header and the capture
 * form: a set value is a solid pill, an unset one a dashed "+" invitation.
 */
function ChipContent({
  label,
  empty,
  tone,
  leading,
}: {
  label: string;
  empty?: boolean;
  tone?: "warning" | "danger";
  leading?: ReactElement | null;
}): ReactElement {
  return (
    <View style={[styles.chip, empty ? styles.chipEmpty : null]}>
      {leading ?? null}
      <Text
        style={[
          styles.chipLabel,
          empty ? styles.chipLabelEmpty : null,
          tone === "warning" ? styles.chipLabelWarning : null,
          tone === "danger" ? styles.chipLabelDanger : null,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

export function TaskStatusChip({
  status,
  onSelect,
  testID,
}: {
  status: TaskStatus;
  onSelect: (status: TaskStatus) => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const leading = useMemo(() => <TaskStatusDot status={status} />, [status]);
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger testID={testID}>
        <ChipContent label={t(TASK_STATUS_LABEL_KEYS[status])} leading={leading} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sheetTitle="Status">
        {TASK_STATUSES.map((candidate) => (
          <StatusMenuItem
            key={candidate}
            status={candidate}
            selected={candidate === status}
            onSelect={onSelect}
            testID={testID ? `${testID.replace(/-trigger$/, "")}-${candidate}` : undefined}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusMenuItem({
  status,
  selected,
  onSelect,
  testID,
}: {
  status: TaskStatus;
  selected: boolean;
  onSelect: (status: TaskStatus) => void;
  testID?: string | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(status), [onSelect, status]);
  const leading = useMemo(() => <TaskStatusDot status={status} />, [status]);
  return (
    <DropdownMenuItem selected={selected} leading={leading} testID={testID} onSelect={handleSelect}>
      {t(TASK_STATUS_LABEL_KEYS[status])}
    </DropdownMenuItem>
  );
}

export function TaskPriorityChip({
  priority,
  onSelect,
  testID,
}: {
  priority: TaskPriority;
  onSelect: (priority: TaskPriority) => void;
  testID?: string;
}): ReactElement {
  const { t } = useTranslation();
  const isSet = priority !== "none";
  let tone: "warning" | "danger" | undefined;
  if (priority === "urgent") {
    tone = "danger";
  } else if (priority === "high") {
    tone = "warning";
  }
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger testID={testID}>
        <ChipContent
          label={isSet ? t(TASK_PRIORITY_LABEL_KEYS[priority]) : "+ Priority"}
          empty={!isSet}
          {...(tone ? { tone } : {})}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sheetTitle="Priority">
        {TASK_PRIORITIES.map((candidate) => (
          <PriorityMenuItem
            key={candidate}
            priority={candidate}
            selected={candidate === priority}
            onSelect={onSelect}
            testID={testID ? `${testID.replace(/-trigger$/, "")}-${candidate}` : undefined}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityMenuItem({
  priority,
  selected,
  onSelect,
  testID,
}: {
  priority: TaskPriority;
  selected: boolean;
  onSelect: (priority: TaskPriority) => void;
  testID?: string | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(priority), [onSelect, priority]);
  return (
    <DropdownMenuItem selected={selected} testID={testID} onSelect={handleSelect}>
      {priority === "none" ? t("tasks.detail.priorityNone") : t(TASK_PRIORITY_LABEL_KEYS[priority])}
    </DropdownMenuItem>
  );
}

/** Due-date chip with the quick presets; "Custom" opens the calendar sheet the
 * chip owns itself, so every caller gets the same complete picker. */
export function TaskDueDateChip({
  dueDate,
  onSetDueDate,
  testID,
}: {
  dueDate: string | null;
  onSetDueDate: (dueDate: string | null) => Promise<unknown> | void;
  testID?: string;
}): ReactElement {
  const toast = useToast();
  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const openCustom = useCallback(() => setIsCustomOpen(true), []);
  const closeCustom = useCallback(() => setIsCustomOpen(false), []);
  const setDueDate = useCallback(
    (value: string | null) => {
      void Promise.resolve(onSetDueDate(value)).catch((error) => {
        toast.show(toErrorMessage(error));
      });
    },
    [onSetDueDate, toast],
  );
  const setQuickDueDate = useCallback(
    (preset: TaskDueDatePreset) => setDueDate(resolveTaskDueDatePreset(preset)),
    [setDueDate],
  );
  const clearDueDate = useCallback(() => setDueDate(null), [setDueDate]);
  const submitCustom = useCallback(
    async (value: string | null) => {
      await onSetDueDate(value);
    },
    [onSetDueDate],
  );

  return (
    <>
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger testID={testID}>
          <ChipContent label={dueDate ?? "+ Due"} empty={dueDate === null} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sheetTitle="Due date" testID="task-due-menu">
          <DueDatePresetMenuItem preset="today" label="Today" onSelect={setQuickDueDate} />
          <DueDatePresetMenuItem preset="tomorrow" label="Tomorrow" onSelect={setQuickDueDate} />
          <DueDatePresetMenuItem preset="next-week" label="Next week" onSelect={setQuickDueDate} />
          <DropdownMenuItem onSelect={openCustom} testID="task-due-custom">
            Custom
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={clearDueDate}
            disabled={dueDate === null}
            testID="task-due-clear"
          >
            Clear
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isCustomOpen ? (
        <TaskDueDateFormSheet
          key={dueDate ?? "empty"}
          currentDueDate={dueDate}
          onSubmit={submitCustom}
          onClose={closeCustom}
        />
      ) : null}
    </>
  );
}

function DueDatePresetMenuItem({
  preset,
  label,
  onSelect,
}: {
  preset: TaskDueDatePreset;
  label: string;
  onSelect: (preset: TaskDueDatePreset) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(preset), [onSelect, preset]);
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`task-due-${preset}`}>
      {label}
    </DropdownMenuItem>
  );
}

/**
 * The labels chip: selected labels render as their own pills inside the
 * trigger, an empty set as a dashed "+ Label". The menu carries creation and —
 * when the host supports it — deletion, so labels are managed where they are
 * applied.
 */
export function TaskLabelsChip({
  projectId,
  projectLabels,
  selectedLabelIds,
  supportsDeletion,
  onSetLabelIds,
  onCreateLabel,
  onDeleteLabel,
  testID,
}: {
  projectId: string;
  projectLabels: readonly TaskLabel[];
  selectedLabelIds: readonly string[];
  supportsDeletion: boolean;
  onSetLabelIds: (labelIds: string[]) => Promise<unknown> | void;
  onCreateLabel: (input: { projectId: string; name: string; color: string }) => Promise<string>;
  onDeleteLabel?: ((labelId: string) => Promise<void>) | undefined;
  testID?: string;
}): ReactElement {
  const toast = useToast();
  const [isChanging, setIsChanging] = useState(false);
  const selectedIds = useMemo(() => new Set(selectedLabelIds), [selectedLabelIds]);
  const selectedLabels = useMemo(
    () => projectLabels.filter((label) => selectedIds.has(label.id)),
    [projectLabels, selectedIds],
  );

  const writeLabelIds = useCallback(
    (next: Set<string>) => {
      setIsChanging(true);
      void Promise.resolve(onSetLabelIds([...next]))
        .catch((error) => {
          toast.show(toErrorMessage(error));
        })
        .finally(() => setIsChanging(false));
    },
    [onSetLabelIds, toast],
  );

  const toggleLabel = useCallback(
    (labelId: string) => {
      if (isChanging) return;
      const next = new Set(selectedIds);
      if (next.has(labelId)) next.delete(labelId);
      else next.add(labelId);
      writeLabelIds(next);
    },
    [isChanging, selectedIds, writeLabelIds],
  );

  const createAndSelectLabel = useCallback(
    async (input: { name: string; color: string }) => {
      const labelId = await onCreateLabel({ projectId, ...input });
      const next = new Set(selectedIds);
      next.add(labelId);
      await Promise.resolve(onSetLabelIds([...next]));
    },
    [onCreateLabel, onSetLabelIds, projectId, selectedIds],
  );

  const deleteProjectLabel = useCallback(
    (label: TaskLabel) => {
      if (!onDeleteLabel) return;
      void (async () => {
        const confirmed = await confirmDialog({
          title: "Delete label?",
          message: `Delete “${label.name}” from this project and every task that uses it?`,
          confirmLabel: "Delete",
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await onDeleteLabel(label.id);
        } catch (error) {
          toast.show(toErrorMessage(error));
        }
      })();
    },
    [onDeleteLabel, toast],
  );

  const pages = useMemo<MenuPageDefinition[]>(
    () => [
      {
        id: "create-label",
        title: "New label",
        content: <CreateTaskLabelPage onCreate={createAndSelectLabel} />,
      },
      {
        id: "delete-label",
        title: "Delete label",
        content:
          projectLabels.length > 0 ? (
            projectLabels.map((label) => (
              <DeleteTaskLabelItem key={label.id} label={label} onDelete={deleteProjectLabel} />
            ))
          ) : (
            <DropdownMenuLabel>No project labels</DropdownMenuLabel>
          ),
      },
    ],
    [createAndSelectLabel, deleteProjectLabel, projectLabels],
  );

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger testID={testID}>
        {selectedLabels.length > 0 ? (
          <View style={styles.labelChips}>
            {selectedLabels.map((label) => (
              <LabelChipPill key={label.id} label={label} />
            ))}
          </View>
        ) : (
          <ChipContent label="+ Label" empty />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        width={260}
        maxHeight={360}
        pages={pages}
        sheetTitle="Labels"
        testID="task-labels-menu"
      >
        {projectLabels.length > 0 ? (
          projectLabels.map((label) => (
            <TaskLabelMenuItem
              key={label.id}
              label={label}
              selected={selectedIds.has(label.id)}
              disabled={isChanging}
              onToggle={toggleLabel}
            />
          ))
        ) : (
          <DropdownMenuLabel>No project labels</DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuSubTrigger id="create-label" testID="task-label-create">
          New label
        </DropdownMenuSubTrigger>
        {supportsDeletion && onDeleteLabel && projectLabels.length > 0 ? (
          <DropdownMenuSubTrigger id="delete-label" testID="task-label-delete">
            Delete label
          </DropdownMenuSubTrigger>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelChipPill({ label }: { label: TaskLabel }): ReactElement {
  const leading = useMemo(
    () => <View style={[styles.labelDot, { backgroundColor: label.color }]} />,
    [label.color],
  );
  return <ChipContent label={label.name} leading={leading} />;
}

function TaskLabelMenuItem({
  label,
  selected,
  disabled,
  onToggle,
}: {
  label: TaskLabel;
  selected: boolean;
  disabled: boolean;
  onToggle: (labelId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onToggle(label.id), [label.id, onToggle]);
  const leading = useMemo(
    () => <View style={[styles.labelDot, { backgroundColor: label.color }]} />,
    [label.color],
  );
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      leading={leading}
      closeOnSelect={false}
      disabled={disabled}
      onSelect={handleSelect}
      testID={`task-label-${label.id}`}
    >
      {label.name}
    </DropdownMenuItem>
  );
}

function DeleteTaskLabelItem({
  label,
  onDelete,
}: {
  label: TaskLabel;
  onDelete: (label: TaskLabel) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onDelete(label), [label, onDelete]);
  const leading = useMemo(
    () => <View style={[styles.labelDot, { backgroundColor: label.color }]} />,
    [label.color],
  );
  return (
    <DropdownMenuItem
      destructive
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
      testID={`task-label-delete-${label.id}`}
    >
      {label.name}
    </DropdownMenuItem>
  );
}

function CreateTaskLabelPage({
  onCreate,
}: {
  onCreate: (input: { name: string; color: string }) => Promise<void>;
}): ReactElement {
  const toast = useToast();
  const goBack = useDropdownMenuBack();
  const [name, setName] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [colorName, setColorName] = useState<(typeof IDENTITY_COLOR_NAMES)[number]>("violet");
  const [isCreating, setIsCreating] = useState(false);
  const submit = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName || isCreating) return;
    setIsCreating(true);
    void (async () => {
      try {
        await onCreate({ name: trimmedName, color: identityColor(colorName) });
        setName("");
        setResetKey((current) => current + 1);
        goBack();
      } catch (error) {
        toast.show(toErrorMessage(error));
      } finally {
        setIsCreating(false);
      }
    })();
  }, [colorName, goBack, isCreating, name, onCreate, toast]);

  return (
    <View style={styles.labelCreateForm}>
      <FormTextInput
        initialValue=""
        resetKey={resetKey}
        onChangeText={setName}
        onSubmitEditing={submit}
        placeholder="Label name"
        testID="task-label-name"
      />
      <View style={styles.labelPalette} accessibilityRole="radiogroup">
        {IDENTITY_COLOR_NAMES.map((candidate) => (
          <TaskLabelColorSwatch
            key={candidate}
            colorName={candidate}
            selected={candidate === colorName}
            onSelect={setColorName}
          />
        ))}
      </View>
      <Button
        variant="default"
        size="sm"
        onPress={submit}
        disabled={!name.trim() || isCreating}
        loading={isCreating}
        testID="task-label-create-submit"
      >
        Create label
      </Button>
    </View>
  );
}

function TaskLabelColorSwatch({
  colorName,
  selected,
  onSelect,
}: {
  colorName: (typeof IDENTITY_COLOR_NAMES)[number];
  selected: boolean;
  onSelect: (colorName: (typeof IDENTITY_COLOR_NAMES)[number]) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(colorName), [colorName, onSelect]);
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);
  const colorStyle = useMemo(() => ({ backgroundColor: identityColor(colorName) }), [colorName]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={colorName}
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={[styles.labelSwatch, colorStyle, selected ? styles.labelSwatchSelected : null]}
      testID={`task-label-color-${colorName}`}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
  },
  chipEmpty: {
    borderStyle: "dashed",
  },
  chipLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  chipLabelEmpty: {
    color: theme.colors.foregroundMuted,
  },
  chipLabelWarning: {
    color: theme.colors.statusWarning,
  },
  chipLabelDanger: {
    color: theme.colors.statusDanger,
  },
  labelChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  labelDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  labelCreateForm: {
    width: "100%",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  labelPalette: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  labelSwatch: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: "transparent",
  },
  labelSwatchSelected: {
    borderColor: theme.colors.foreground,
  },
}));
