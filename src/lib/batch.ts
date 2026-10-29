// 批量操作（R-06）：多选仓库后批量 Fetch / Pull / 按同步规则推送
import i18n from '../i18n';
import { api } from '../api';
import type { RepoView } from '../api/types';
import { reportError } from '../api/queries';
import { useApp } from '../stores/appStore';
import { pullStrategy } from './actions';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;

export type BatchAction = 'fetch' | 'pull' | 'sync';

export async function runBatch(action: BatchAction, repos: RepoView[]) {
  const list = repos.filter((r) => !r.missing);
  if (list.length === 0) return;
  const app = useApp.getState();
  // 危险操作确认规则（specs/02 第 10 节）：批量推送需确认
  if (action === 'sync') {
    const ok = await app.ask({
      title: t('batch.syncTitle', { count: list.length }),
      body: t('batch.syncBody'),
      items: list.map((r) => r.name),
      note: t('batch.syncNote'),
      confirmLabel: t('batch.sync'),
    });
    if (!ok) return;
  }
  let failed = 0;
  for (const r of list) {
    try {
      if (action === 'fetch') await api.task.fetch(r.id);
      else if (action === 'pull') await api.task.pull(r.id, pullStrategy());
      else await api.task.sync(r.id, { branches: null, targetIds: null, pullStrategy: pullStrategy(), confirmedForce: [] });
    } catch (e) {
      failed++;
      reportError(e);
    }
  }
  app.setBottom(true, 'tasks');
  if (failed < list.length) app.toast('info', t('batch.started', { count: list.length - failed }));
}
