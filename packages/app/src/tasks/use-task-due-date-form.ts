import { useEffect, useState } from "react";
import { openTaskDueDateForm } from "./task-due-date";

export function useTaskDueDateForm(currentDueDate: string | null) {
  const [model] = useState(() => openTaskDueDateForm(currentDueDate));

  useEffect(() => {
    return () => model.close();
  }, [model]);

  return model;
}
