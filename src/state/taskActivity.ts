// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand'

export interface TaskProgress {
  text: string
  percent: number | null
}

export function progressPhaseText(text: string, percent: number | null): string {
  if (percent === null) return text
  return text.replace(/\s*(?::|-)?\s*(\d+(?:\.\d+)?)%\s*$/, (suffix, value: string) =>
    Number(value) === percent ? '' : suffix)
}

interface TaskActivity {
  tasks: Record<string, TaskProgress>
  setTask(id: string, progress: TaskProgress | null): void
}

export const useTaskActivity = create<TaskActivity>((set) => ({
  tasks: {},
  setTask: (id, progress) => set((state) => {
    const tasks = { ...state.tasks }
    if (progress) tasks[id] = progress
    else delete tasks[id]
    return { tasks }
  }),
}))
