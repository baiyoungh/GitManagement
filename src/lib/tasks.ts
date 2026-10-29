import i18n from '../i18n';
import type { TaskInfo } from '../api/types';

export function taskTitle(task: TaskInfo): string {
  const key = `tasks.kind.${task.kind}`;
  return i18n.exists(key) ? (i18n.t(key, task.params) as string) : task.kind;
}
