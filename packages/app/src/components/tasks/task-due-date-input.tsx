import type { ReactElement } from "react";
import { FormTextInput } from "@/components/ui/form-field";
import type { TaskDueDateInputProps } from "./task-due-date-input.types";

export function TaskDueDateInput({
  value,
  onChange,
  disabled,
  size,
}: TaskDueDateInputProps): ReactElement {
  return (
    <FormTextInput
      size={size}
      testID="task-due-date-custom-input"
      accessibilityLabel="Due date"
      initialValue={value}
      value={value}
      onChangeText={onChange}
      editable={!disabled}
      placeholder="YYYY-MM-DD"
      keyboardType="numbers-and-punctuation"
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}
