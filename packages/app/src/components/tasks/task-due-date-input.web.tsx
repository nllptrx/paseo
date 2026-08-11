import { useCallback, useState, type ChangeEvent, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { createControlGeometry } from "@/components/ui/control-geometry";
import type { TaskDueDateInputProps } from "./task-due-date-input.types";

export function TaskDueDateInput({
  value,
  onChange,
  disabled,
  size,
}: TaskDueDateInputProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value),
    [onChange],
  );
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);

  return (
    <View
      style={[
        styles.inputChrome,
        size === "sm" ? styles.inputChromeSm : styles.inputChromeMd,
        focused ? styles.inputChromeFocused : null,
        disabled ? styles.inputChromeDisabled : null,
      ]}
    >
      <ThemedNativeDateInput
        type="date"
        aria-label="Due date"
        data-testid="task-due-date-custom-input"
        value={value}
        disabled={disabled}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
      />
    </View>
  );
}

const nativeInputStyle = {
  width: "100%",
  minWidth: 0,
  height: "100%",
  padding: 0,
  border: 0,
  outline: "none",
  color: "inherit",
  background: "transparent",
  font: "inherit",
  boxSizing: "border-box",
} as const;

interface NativeDateInputProps {
  type: "date";
  "aria-label": string;
  "data-testid": string;
  value: string;
  disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  colorScheme?: "light" | "dark";
}

function NativeDateInput({ colorScheme, ...props }: NativeDateInputProps): ReactElement {
  return (
    <input
      {...props}
      style={colorScheme === "dark" ? nativeInputDarkStyle : nativeInputLightStyle}
    />
  );
}

const nativeInputLightStyle = { ...nativeInputStyle, colorScheme: "light" } as const;
const nativeInputDarkStyle = { ...nativeInputStyle, colorScheme: "dark" } as const;
const ThemedNativeDateInput = withUnistyles(NativeDateInput, (theme) => ({
  colorScheme: theme.colorScheme,
}));

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);
  return {
    inputChrome: {
      ...geometry.controlRest,
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
    },
    inputChromeSm: geometry.formTextInputSm,
    inputChromeMd: geometry.formTextInputMd,
    inputChromeFocused: geometry.controlActive,
    inputChromeDisabled: geometry.controlDisabled,
  };
});
