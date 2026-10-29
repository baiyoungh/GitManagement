import { create } from 'zustand';
import type { CommandLogEntry, TaskInfo, TaskProgress } from '../api/types';

const LOG_LIMIT = 1000;

interface TaskStore {
  tasks: Record<string, TaskInfo>;
  logs: CommandLogEntry[];
  upsert: (t: TaskInfo) => void;
  progress: (p: TaskProgress) => void;
  setAll: (tasks: TaskInfo[]) => void;
  clearFinished: () => void;
  addLog: (e: CommandLogEntry) => void;
  setLogs: (e: CommandLogEntry[]) => void;
}

export const useTasks = create<TaskStore>((set) => ({
  tasks: {},
  logs: [],
  upsert: (t) => set((s) => ({ tasks: { ...s.tasks, [t.id]: { ...s.tasks[t.id], ...t } } })),
  progress: (p) =>
    set((s) => {
      const t = s.tasks[p.taskId];
      if (!t) return s;
      return {
        tasks: { ...s.tasks, [p.taskId]: { ...t, percent: p.percent ?? t.percent, message: p.message } },
      };
    }),
  setAll: (tasks) => set({ tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) }),
  clearFinished: () =>
    set((s) => ({
      tasks: Object.fromEntries(
        Object.entries(s.tasks).filter(([, t]) => t.state === 'queued' || t.state === 'running'),
      ),
    })),
  addLog: (e) => set((s) => ({ logs: [...s.logs.slice(-(LOG_LIMIT - 1)), e] })),
  setLogs: (logs) => set({ logs }),
}));

/** 等待后台任务结束（用于"提交并推送"等串联流程） */
export function waitForTask(taskId: string): Promise<TaskInfo> {
  return new Promise((resolve) => {
    const check = (t?: TaskInfo) => {
      if (t && t.state !== 'queued' && t.state !== 'running') {
        unsub();
        resolve(t);
        return true;
      }
      return false;
    };
    const unsub = useTasks.subscribe((s) => {
      check(s.tasks[taskId]);
    });
    check(useTasks.getState().tasks[taskId]);
  });
}
