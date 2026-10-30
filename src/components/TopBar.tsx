// 顶栏（specs/06 第 1 节）：当前仓库、分支、Fetch / Pull / Push、设置
import { useTranslation } from 'react-i18next';
import { useRepos, useSummary } from '../api/queries';
import { useApp } from '../stores/appStore';
import { AheadBehind } from './ui';
import { Icon } from './Icon';
import { openPush, startFetch, startPull } from '../lib/actions';
import { openSyncPreview } from '../dialogs/SyncDialog';
import { isMac } from '../lib/format';
import { Terminal } from 'lucide-react';

export function TopBar() {
  const { t } = useTranslation();
  const repoId = useApp((s) => s.selectedRepoId);
  const setTab = useApp((s) => s.setTab);
  const openDialog = useApp((s) => s.openDialog);
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === repoId);
  const summary = useSummary(repoId ?? '', !!repo && !repo.missing);
  const s = summary.data;
  const disabled = !repo || repo.missing;
  const mod = isMac ? '⌘' : 'Ctrl+';

  const branchLabel = s
    ? s.detached
      ? t('top.detached', { hash: s.headShort ?? '' })
      : s.lastCommitTime === null && s.branch
        ? t('top.unborn', { branch: s.branch })
        : s.branch
    : '';

  return (
    <header className="topbar">
      <span className="brand">GitManagement</span>
      <button className="topbar-repo repo-switcher-button" onClick={() => openDialog({ type: 'repoSwitcher' })} title={t('repoSwitcher.title')}>
        <Icon name="folder" size={14} />{repo ? repo.name : t('top.noRepo')}<Icon name="chevronDown" size={12} />
      </button>
      {repo && s && (
        <button className="branch-chip" onClick={() => repoId && openDialog({ type: 'branchPopup', repoId })} onDoubleClick={() => setTab('branches')} title={`${t('nav.branches')} (${mod}⇧\`)`}>
          <Icon name="branch" size={14} /> {branchLabel} <AheadBehind ahead={s.ahead} behind={s.behind} />
        </button>
      )}
      <div className="topbar-actions">
        <button disabled={disabled} onClick={() => repoId && startFetch(repoId)} title="Fetch">
          <Icon name="refresh" size={14} /> {t('top.fetch')}
        </button>
        <button disabled={disabled} onClick={() => repoId && startPull(repoId)} title={`${mod}T`}>
          <Icon name="pull" size={14} /> {t('top.pull')}
        </button>
        <button disabled={disabled || !s?.branch} onClick={() => repoId && openPush(repoId)} title={`${mod}⇧K`}>
          <Icon name="push" size={14} /> {t('top.push')}
        </button>
        <button
          disabled={disabled || !s?.branch}
          onClick={() => repoId && s?.branch && openSyncPreview(repoId, [s.branch], null)}
          title={s?.detached ? t('errors.sync.detachedHead') : t('top.syncHint')}
        >
          <Icon name="sync" size={14} /> {t('top.sync')}
        </button>
        <button className="icon-btn" onClick={() => openDialog({ type: 'settings' })} title={t('top.settings')} aria-label={t('top.settings')}>
          <Icon name="settings" size={18} />
        </button>
        <button className="icon-btn" disabled={disabled} onClick={() => useApp.getState().setBottom(true, 'terminal')} title={t('terminal.title')} aria-label={t('terminal.title')}>
          <Terminal size={18} />
        </button>
      </div>
    </header>
  );
}
