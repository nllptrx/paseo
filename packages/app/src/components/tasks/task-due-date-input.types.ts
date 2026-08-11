import type { FieldControlSize } from "@/components/ui/control-geometry";

export interface TaskDueDateInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  size: FieldControlSize;
}
