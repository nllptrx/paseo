import {
  forwardRef,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  View,
  type PointerEvent as RNPointerEvent,
  type PressableStateCallbackType,
  type TextInput,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { GripHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-modal-sheet";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
  type FieldControlSize,
} from "@/components/ui/control-geometry";

interface FieldProps {
  label: string;
  children: ReactNode;
  hint?: string;
  error?: string | null;
  testID?: string;
}

export function Field({ label, children, hint, error, testID }: FieldProps) {
  const hintTestID = useMemo(() => (testID ? `${testID}-hint` : undefined), [testID]);
  const errorTestID = useMemo(() => (testID ? `${testID}-error` : undefined), [testID]);
  const subtext = useMemo(() => {
    if (error) {
      return (
        <Text numberOfLines={1} style={styles.errorText} testID={errorTestID}>
          {error}
        </Text>
      );
    }
    if (hint) {
      return (
        <Text numberOfLines={1} style={styles.hintText} testID={hintTestID}>
          {hint}
        </Text>
      );
    }
    return null;
  }, [error, hint, errorTestID, hintTestID]);

  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      {children}
      {subtext}
    </View>
  );
}

type FormTextInputProps = AdaptiveTextInputProps & {
  size?: FieldControlSize;
};

type FlatFormTextInputStyle = ViewStyle & TextStyle;
type ResizeMode = "none" | "both" | "horizontal" | "vertical";
type WebFormTextInputStyle = FlatFormTextInputStyle & {
  overflowY?: "visible" | "hidden" | "scroll" | "auto";
  resize?: ResizeMode;
};

interface SplitFormTextInputStyle {
  chromeStyle?: ViewStyle;
  inputStyle?: TextStyle;
  resize?: ResizeMode;
}

function splitFormTextInputStyle(style: AdaptiveTextInputProps["style"]): SplitFormTextInputStyle {
  const flattened = RNStyleSheet.flatten(style) as WebFormTextInputStyle | undefined;
  if (!flattened) {
    return {};
  }

  const {
    color,
    fontFamily,
    fontSize,
    fontStyle,
    fontVariant,
    fontWeight,
    includeFontPadding,
    letterSpacing,
    lineHeight,
    textAlign,
    textAlignVertical,
    textDecorationColor,
    textDecorationLine,
    textDecorationStyle,
    textShadowColor,
    textShadowOffset,
    textShadowRadius,
    textTransform,
    writingDirection,
    overflowY,
    resize,
    ...chromeStyle
  } = flattened;

  const inputStyle: TextStyle = {
    color,
    fontFamily,
    fontSize,
    fontStyle,
    fontVariant,
    fontWeight,
    includeFontPadding,
    letterSpacing,
    lineHeight,
    textAlign,
    textAlignVertical,
    textDecorationColor,
    textDecorationLine,
    textDecorationStyle,
    textShadowColor,
    textShadowOffset,
    textShadowRadius,
    textTransform,
    writingDirection,
  };

  return {
    chromeStyle: stripUnistylesMetadata(chromeStyle),
    inputStyle: stripUnistylesMetadata({ ...inputStyle, overflowY }) as TextStyle,
    resize,
  };
}

function stripUnistylesMetadata<TStyle extends object>(style: TStyle): TStyle {
  const cleanStyle: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
    if (key.startsWith("unistyles_") || value === undefined) {
      continue;
    }
    cleanStyle[key] = value;
  }
  return cleanStyle as TStyle;
}

function assignTextInputRef(forwardedRef: ForwardedRef<TextInput>, node: TextInput | null): void {
  if (typeof forwardedRef === "function") {
    forwardedRef(node);
    return;
  }
  if (forwardedRef) {
    forwardedRef.current = node;
  }
}

export const FormTextInput = forwardRef<TextInput, FormTextInputProps>(function FormTextInput(
  { size = "md", style, onFocus, onBlur, editable, ...props },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [resizedHeight, setResizedHeight] = useState<number | null>(null);
  const inputElementRef = useRef<TextInput | null>(null);
  const isDisabled = editable === false;
  const isMultiline = props.multiline === true;
  const chromeSizeStyle = size === "sm" ? formInputStyles.chromeSm : formInputStyles.chromeMd;
  const inputSizeStyle = size === "sm" ? formInputStyles.inputSm : formInputStyles.inputMd;
  const splitStyle = useMemo(() => splitFormTextInputStyle(style), [style]);
  const setInputRef = useCallback(
    (node: TextInput | null) => {
      inputElementRef.current = node;
      assignTextInputRef(ref, node);
    },
    [ref],
  );
  const handleGripPointerDown = useCallback((event: RNPointerEvent) => {
    const element = inputElementRef.current as unknown as HTMLElement | null;
    const grip = event.currentTarget as unknown as HTMLElement | null;
    if (!element || !grip) {
      return;
    }

    const { pointerId, clientY } = event.nativeEvent;
    const startHeight = element.getBoundingClientRect().height;
    const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
    const minHeight = Number.isFinite(lineHeight) ? lineHeight : startHeight;

    event.preventDefault();
    event.stopPropagation();
    grip.setPointerCapture?.(pointerId);

    function handleMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      moveEvent.preventDefault();
      setResizedHeight(Math.max(minHeight, startHeight + moveEvent.clientY - clientY));
    }

    function handleUp(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) {
        return;
      }
      if (grip?.hasPointerCapture?.(pointerId)) {
        grip.releasePointerCapture(pointerId);
      }
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
  }, []);
  const handleFocus = useCallback<NonNullable<AdaptiveTextInputProps["onFocus"]>>(
    (event) => {
      setFocused(true);
      onFocus?.(event);
    },
    [onFocus],
  );
  const handleBlur = useCallback<NonNullable<AdaptiveTextInputProps["onBlur"]>>(
    (event) => {
      setFocused(false);
      onBlur?.(event);
    },
    [onBlur],
  );
  const inputStyle = useMemo(
    () => [
      formInputStyles.input,
      inputSizeStyle,
      isWeb && isMultiline && formInputStyles.multilineInput,
      splitStyle.inputStyle,
      resizedHeight === null ? null : { height: resizedHeight },
    ],
    [inputSizeStyle, isMultiline, resizedHeight, splitStyle.inputStyle],
  ) as AdaptiveTextInputProps["style"];
  const showResizeHandle = isWeb && splitStyle.resize === "vertical";
  const chromeStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      formInputStyles.chrome,
      chromeSizeStyle,
      resolveControlInteractionStyles(
        {
          controlRest: formInputStyles.controlRest,
          controlHover: formInputStyles.controlHover,
          controlActive: formInputStyles.controlActive,
          controlDisabled: formInputStyles.controlDisabled,
        },
        {
          hovered,
          focused,
          disabled: isDisabled,
        },
      ),
      splitStyle.chromeStyle,
    ],
    [chromeSizeStyle, focused, isDisabled, splitStyle.chromeStyle],
  );

  return (
    <Pressable disabled={isDisabled} style={chromeStyle}>
      <AdaptiveTextInput
        ref={setInputRef}
        editable={editable}
        {...props}
        onBlur={handleBlur}
        onFocus={handleFocus}
        style={inputStyle}
      />
      {showResizeHandle ? (
        <View
          role="separator"
          aria-orientation="horizontal"
          style={[formInputStyles.resizeGrip, RESIZE_GRIP_CURSOR]}
          onPointerDown={handleGripPointerDown}
          testID={props.testID ? `${props.testID}-resize-handle` : undefined}
        >
          <ThemedGrip size={ICON_SIZE.md} uniProps={gripIconMapping} />
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.4),
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.4),
  },
}));

const ThemedGrip = withUnistyles(GripHorizontal);
const gripIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const RESIZE_GRIP_CURSOR = { cursor: "row-resize", touchAction: "none" } as object;

const formInputStyles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    resizeGrip: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: theme.spacing[3],
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1,
    },
    chrome: {
      position: "relative",
      backgroundColor: theme.colors.surface2,
    },
    chromeSm: {
      ...geometry.fieldControlSm,
    },
    chromeMd: {
      ...geometry.fieldControlMd,
    },
    controlRest: {
      ...geometry.controlRest,
    },
    controlHover: {
      ...geometry.controlHover,
    },
    controlActive: {
      ...geometry.controlActive,
    },
    controlDisabled: {
      ...geometry.controlDisabled,
    },
    input: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      paddingHorizontal: 0,
      paddingVertical: 0,
      outlineColor: "transparent",
      outlineWidth: 0,
    },
    multilineInput: {
      flexBasis: "auto",
      flexGrow: 0,
      flexShrink: 0,
      width: "100%",
    },
    inputSm: {
      ...geometry.fieldTextSm,
    },
    inputMd: {
      ...geometry.fieldTextMd,
    },
  };
});
