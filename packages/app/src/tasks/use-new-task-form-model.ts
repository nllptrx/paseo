import { useEffect, useState } from "react";
import {
  openNewTaskForm,
  type NewTaskFormModel,
  type NewTaskFormSnapshot,
} from "./new-task-form-model";

export function useNewTaskFormModel(snapshot: NewTaskFormSnapshot): NewTaskFormModel {
  const [model] = useState(() => openNewTaskForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  return model;
}
