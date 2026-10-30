import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BranchInfo } from '../api/types';
import { invalidateRepo, reportError, useStatus } from '../api/queries';
import type { MenuItem } from '../components/ui';
import { openSyncPreview } from '../dialogs/SyncDialog';
import { checkoutBranch, openPush } from '../lib/actions';
import { useApp } from '../stores/appStore';

export function useBranchActions(repoId: string, branches: BranchInfo[], onCompare?: (branch: BranchInfo) => void) {
  const { t } = useTranslation();
  const status = useStatus(repoId);
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const openDialog = useApp((s) => s.openDialog);
  const refresh = () => invalidateRepo(repoId);
  const hasHead = !!status.data?.branch.oid;

  const checkout = async (b: BranchInfo) => {
    try {
      if (b.kind === 'local') await checkoutBranch(repoId, b.name);
      else if (b.remote && b.remoteBranch) {
        const existing = branches.find((x) => x.kind === 'local' && x.name === b.remoteBranch);
        if (existing) await checkoutBranch(repoId, existing.name);
        else {
          const name = await api.branch.checkoutRemote(repoId, b.remote, b.remoteBranch);
          toast('success', t('branches.checkedOut', { name }));
        }
      }
    } catch (e) { reportError(e); }
    finally { refresh(); }
  };

  const integrate = async (b: BranchInfo, mode: 'merge' | 'rebase') => {
    if (!await ask({
      title: t(mode === 'merge' ? 'integrate.mergeTitle' : 'integrate.rebaseTitle'),
      body: t(mode === 'merge' ? 'integrate.mergeBody' : 'integrate.rebaseBody', { target: b.name, current: status.data?.branch.head ?? 'HEAD' }),
    })) return;
    try {
      const result = await api.branch.integrate(repoId, b.fullRef, mode);
      toast(result.conflicts ? 'error' : 'success', t(result.conflicts ? 'integrate.conflicts' : 'integrate.done'));
      if (result.conflicts) {
        useApp.getState().selectRepo(repoId);
        useApp.getState().setTab('changes');
      }
    } catch (e) { reportError(e); }
    finally { refresh(); }
  };

  const deleteRemote = async (b: BranchInfo) => {
    if (!b.remote || !b.remoteBranch || !await ask({
      title: t('deleteBranch.remoteTitle', { name: b.name }),
      body: t('deleteBranch.remoteBody', { name: b.name }),
      note: t('common.irreversible'), danger: true, confirmLabel: t('common.delete'),
    })) return;
    try {
      await api.branch.deleteRemote(repoId, b.remote, b.remoteBranch);
      toast('success', t('branches.deleted', { name: b.name }));
    } catch (e) { reportError(e); }
    finally { refresh(); }
  };

  const actionsFor = (b: BranchInfo): MenuItem[] => [
    { label: t('branches.checkout'), disabled: b.isHead, onClick: () => checkout(b) },
    { label: t('branches.newBranchFromName', { name: b.name }), onClick: () => openDialog({ type: 'createBranch', repoId, startPoint: b.fullRef }) },
    { separator: true },
    {
      label: t('branches.compareWithCurrent'), disabled: b.isHead || !hasHead,
      onClick: () => onCompare ? onCompare(b) : openDialog({ type: 'compare', repoId, left: 'HEAD', right: b.fullRef }),
    },
    { label: t('branches.compareWithWorktree'), onClick: () => openDialog({ type: 'compare', repoId, left: b.fullRef, right: null }) },
    { label: t('log.newTag'), onClick: () => openDialog({ type: 'tag', repoId, target: b.fullRef, label: b.name }) },
    { separator: true },
    { label: t('branches.merge'), disabled: b.isHead || !hasHead || !!status.data?.operation, onClick: () => integrate(b, 'merge') },
    { label: t('branches.rebase'), disabled: b.isHead || !hasHead || !!status.data?.operation, onClick: () => integrate(b, 'rebase') },
    { separator: true },
    ...(b.kind === 'local' ? [
      { label: t('branches.push'), onClick: () => openPush(repoId, b.name) },
      { label: t('branches.syncByRule'), onClick: () => openSyncPreview(repoId, [b.name], null) },
      { label: t('branches.editRule'), onClick: () => { useApp.getState().selectRepo(repoId); useApp.getState().setTab('mapping'); } },
      { label: t('branches.setUpstream'), onClick: () => openDialog({ type: 'upstream', repoId, name: b.name }) },
      {
        label: t('branches.unsetUpstream'), disabled: !b.upstream,
        onClick: () => api.branch.setUpstream(repoId, b.name, null, null).then(() => toast('success', t('branches.upstreamSet')), reportError).finally(refresh),
      },
      { label: t('branches.rename'), onClick: () => openDialog({ type: 'renameBranch', repoId, name: b.name }) },
      {
        label: t('branches.delete'), danger: true, disabled: b.isHead,
        onClick: () => openDialog({ type: 'deleteBranch', repoId, name: b.name,
          upstream: b.upstreamRemote && b.upstreamBranch && !b.upstreamGone ? { remote: b.upstreamRemote, branch: b.upstreamBranch } : null }),
      },
    ] : [{ label: t('branches.delete'), danger: true, onClick: () => deleteRemote(b) }]),
  ];

  return { actionsFor, checkout };
}
