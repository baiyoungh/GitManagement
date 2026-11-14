import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { AuthChallenge, CommandLogEntry, TaskInfo, TaskProgress } from '../api/types';
import { useAuth } from '../stores/authStore';
import { invalidateRepo, keys, queryClient } from '../api/queries';
import { useApp } from '../stores/appStore';
import { useTasks } from '../stores/taskStore';
import { errorDetail, errorMessage } from '../lib/errors';
import { taskTitle } from '../lib/tasks';

/** 订阅后端事件：repo-changed / task-updated / task-progress / command-log */
export function useBackendEvents() {
  const { t } = useTranslation();

  useEffect(() => {
    let disposed = false;
    const unsubs: (() => void)[] = [];
    const add = (p: Promise<() => void>) =>
      p.then((u) => {
        if (disposed) u();
        else unsubs.push(u);
      });

    // 文件监听的事件可能很密集，按仓库再做一次合并
    const pending = new Map<string, number>();
    add(
      listen<{ repoId: string }>('repo-changed', (e) => {
        const id = e.payload.repoId;
        if (pending.has(id)) return;
        pending.set(
          id,
          window.setTimeout(() => {
            pending.delete(id);
            invalidateRepo(id);
          }, 150),
        );
      }),
    );

    add(
      listen<TaskInfo>('task-updated', (e) => {
        const task = e.payload;
        const prev = useTasks.getState().tasks[task.id];
        useTasks.getState().upsert(task);
        const finished = task.state !== 'queued' && task.state !== 'running';
        const wasRunning = !prev || prev.state === 'queued' || prev.state === 'running';
        if (finished && wasRunning) {
          const title = taskTitle(task);
          const { toast } = useApp.getState();
          if (task.state === 'failed') toast('error', `${t('tasks.failed', { task: title })}：${errorMessage(task.error)}`, errorDetail(task.error));
          else if (task.state === 'succeeded') toast('success', t('tasks.succeeded', { task: title }));
          if (task.kind === 'clone') {
            void queryClient.invalidateQueries({ queryKey: keys.repos });
            if (task.state !== 'failed' || task.error?.code !== 'git.authFailed') useAuth.getState().forgetClone(task.id);
          }
          if (task.repoId) invalidateRepo(task.repoId);
        }
      }),
    );

    add(listen<TaskProgress>('task-progress', (e) => useTasks.getState().progress(e.payload)));
    add(listen<CommandLogEntry>('command-log', (e) => useTasks.getState().addLog(e.payload)));

    // Register both listeners before requesting a snapshot; resolved-ID tombstones
    // protect against auth-resolved arriving while auth_pending is in flight.
    const authListeners = [
      add(listen<AuthChallenge>('auth-challenge', (e) => {
        if (disposed) return;
        useAuth.getState().upsert(e.payload);
        useApp.getState().setBottom(true, 'tasks');
      })),
      add(listen<{ id: string }>('auth-resolved', (e) => {
        if (!disposed) useAuth.getState().resolve(e.payload.id);
      })),
      add(listen<{ code: string }>('auth-warning', () => {
        if (!disposed) useApp.getState().toast('error', t('auth.saveFailed'));
      })),
    ];
    void Promise.all(authListeners).then(() => {
      if (!disposed) return api.auth.pending().then((items) => {
        if (!disposed) useAuth.getState().mergePending(items);
      });
    }).catch(() => undefined);

    // 首次加载已有的任务与日志
    void api.task.list().then((ts) => useTasks.getState().setAll(ts));
    void api.log.list().then((ls) => useTasks.getState().setLogs(ls));

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
      pending.forEach((h) => clearTimeout(h));
    };
  }, [t]);
}
