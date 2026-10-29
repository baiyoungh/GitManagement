// 跨组件复用的操作流程
import i18n from '../i18n';
import { api } from '../api';
import type { PullStrategy } from '../api/types';
import { reportError } from '../api/queries';
import { useApp } from '../stores/appStore';

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;

export function pullStrategy(): PullStrategy {
  const v = useApp.getState().settings.pullStrategy;
  return v === 'rebase' || v === 'ffOnly' ? v : 'merge';
}

export async function startPull(repoId: string) {
  try {
    await api.task.pull(repoId, pullStrategy());
    useApp.getState().setBottom(true, 'tasks');
  } catch (e) {
    reportError(e);
  }
}

export async function startFetch(repoId: string) {
  try {
    await api.task.fetch(repoId);
  } catch (e) {
    reportError(e);
  }
}

export function openPush(repoId: string, branch?: string) {
  useApp.getState().openDialog({ type: 'push', repoId, branch });
}

/** 切换分支（B-03）：普通切换失败且原因是本地改动会被覆盖时，询问智能切换/强制切换 */
export async function checkoutBranch(repoId: string, name: string): Promise<boolean> {
  const { toast, ask } = useApp.getState();
  try {
    await api.branch.checkout(repoId, name, 'normal');
    toast('success', t('branches.checkedOut', { name }));
    return true;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code !== 'git.localChangesOverwritten') {
      reportError(e);
      return false;
    }
  }
  const choice = await useApp.getState().choose({
    title: t('checkoutDialog.title', { branch: name }),
    body: `${t('checkoutDialog.body')}\n\n${t('checkoutDialog.smart')}：${t('checkoutDialog.smartDesc')}\n${t('checkoutDialog.force')}：${t('checkoutDialog.forceDesc')}`,
    confirmLabel: t('checkoutDialog.smart'),
    altLabel: t('checkoutDialog.force'),
    altDanger: true,
  });
  if (choice === 'cancel') return false;
  if (choice === 'confirm') {
    try {
      const r = await api.branch.checkout(repoId, name, 'smart');
      if (r.stashConflict) toast('error', t('checkoutDialog.stashConflict'));
      else toast('success', t('branches.checkedOut', { name }));
      return true;
    } catch (e) {
      reportError(e);
      return false;
    }
  }
  const force = await ask({
    title: t('checkoutDialog.forceConfirmTitle'),
    body: `${t('checkoutDialog.forceDesc')}`,
    note: t('common.irreversible'),
    confirmLabel: t('checkoutDialog.force'),
    danger: true,
  });
  if (!force) return false;
  try {
    await api.branch.checkout(repoId, name, 'force');
    toast('success', t('branches.checkedOut', { name }));
    return true;
  } catch (e) {
    reportError(e);
    return false;
  }
}
