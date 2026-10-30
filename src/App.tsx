import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import { reportError, useAppInfo, useRepos } from './api/queries';
import { useApp, type Tab } from './stores/appStore';
import { useBackendEvents } from './hooks/useBackendEvents';
import { useCloseGuard } from './hooks/useCloseGuard';
import { detectSystemLanguage, setLanguage } from './i18n';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { SplitView } from './components/SplitView';
import { BottomPanel } from './components/BottomPanel';
import { ConfirmHost, Toasts } from './components/ui';
import { useStashes } from './api/queries';
import { Overview } from './views/Overview';
import { ChangesView } from './views/ChangesView';
import { FilesView } from './views/FilesView';
import { BranchesView } from './views/BranchesView';
import { LogView } from './views/LogView';
import { MappingView } from './views/MappingView';
import { SyncDialogHost } from './dialogs/SyncDialog';
import { AddRepoDialog, CloneDialog } from './dialogs/RepoDialogs';
import { PushDialog } from './dialogs/PushDialog';
import { CreateBranchDialog, DeleteBranchDialog, RenameBranchDialog, UpstreamDialog } from './dialogs/BranchDialogs';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { StashView } from './views/StashView';
import { ScanDialog } from './dialogs/ScanDialog';
import { StashCreateDialog } from './dialogs/StashCreateDialog';
import { TagDialog } from './dialogs/TagDialog';
import { CompareDialog } from './dialogs/CompareDialog';
import { FileHistoryDialog } from './dialogs/FileHistoryDialog';
import { BranchPopup, RepoSwitcher } from './dialogs/QuickPickers';
import { PromptHost } from './components/ui';
import { isMac } from './lib/format';
import { openPush, startPull } from './lib/actions';

const TABS: Tab[] = ['changes', 'files', 'log', 'branches', 'mapping', 'stash'];

function Dialogs() {
  const d = useApp((s) => s.dialog);
  if (!d) return null;
  switch (d.type) {
    case 'addRepo':
      return <AddRepoDialog />;
    case 'clone':
      return <CloneDialog />;
    case 'settings':
      return <SettingsDialog />;
    case 'push':
      return <PushDialog repoId={d.repoId} branch={d.branch} />;
    case 'createBranch':
      return <CreateBranchDialog repoId={d.repoId} startPoint={d.startPoint} />;
    case 'renameBranch':
      return <RenameBranchDialog repoId={d.repoId} name={d.name} />;
    case 'upstream':
      return <UpstreamDialog repoId={d.repoId} name={d.name} />;
    case 'deleteBranch':
      return <DeleteBranchDialog repoId={d.repoId} name={d.name} upstream={d.upstream} />;
    case 'scan':
      return <ScanDialog initialRoot={d.root} initialGroup={d.groupId} />;
    case 'stashCreate':
      return <StashCreateDialog repoId={d.repoId} paths={d.paths} />;
    case 'tag':
      return <TagDialog repoId={d.repoId} target={d.target} label={d.label} />;
    case 'compare':
      return <CompareDialog repoId={d.repoId} left={d.left} right={d.right} />;
    case 'fileHistory':
      return <FileHistoryDialog repoId={d.repoId} path={d.path} mode={d.mode} />;
    case 'branchPopup':
      return <BranchPopup repoId={d.repoId} />;
    case 'repoSwitcher':
      return <RepoSwitcher />;
    default:
      return null;
  }
}

/** 主题：跟随系统 / 亮 / 暗 */
function useTheme(theme: string | undefined) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || ((!theme || theme === 'system') && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

/** 外观（T-04）：字体、字号、差异颜色写入 CSS 变量 */
function useAppearance(settings: Record<string, string>) {
  const font = settings['code.font'];
  const uiSize = settings['ui.fontSize'];
  const codeSize = settings['code.fontSize'];
  const add = settings['diff.color.add'];
  const rem = settings['diff.color.rem'];
  const chg = settings['diff.color.chg'];
  useEffect(() => {
    const st = document.documentElement.style;
    const setVar = (k: string, v: string | null) => (v ? st.setProperty(k, v) : st.removeProperty(k));
    setVar('--mono', font?.trim() ? `${font}, Menlo, Consolas, monospace` : null);
    setVar('--ui-size', uiSize ? `${uiSize}px` : null);
    setVar('--code-size', codeSize ? `${codeSize}px` : null);
    // 自定义差异色：背景与行内高亮使用不同透明度，亮/暗主题都可读
    const mix = (c: string | undefined, pct: number) => (c ? `color-mix(in srgb, ${c} ${pct}%, var(--bg))` : null);
    setVar('--d-add-bg', mix(add, 18));
    setVar('--d-add-hl', mix(add, 40));
    setVar('--d-rem-bg', mix(rem, 15));
    setVar('--d-rem-hl', mix(rem, 35));
    setVar('--d-chg-bg', mix(chg, 15));
    setVar('--d-chg-hl', mix(chg, 35));
  }, [font, uiSize, codeSize, add, rem, chg]);
}

/** 定时自动 Fetch（S-01） */
function useAutoFetch(minutes: number) {
  useEffect(() => {
    if (!minutes || minutes <= 0) return;
    const h = window.setInterval(() => void api.task.fetchAll().catch(() => undefined), minutes * 60_000);
    return () => window.clearInterval(h);
  }, [minutes]);
}

export function App() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const settings = useApp((s) => s.settings);
  const repoId = useApp((s) => s.selectedRepoId);
  const tab = useApp((s) => s.tab);
  const bottomOpen = useApp((s) => s.bottomOpen);
  const setTab = useApp((s) => s.setTab);
  const repos = useRepos();
  const info = useAppInfo();
  const repo = repos.data?.find((r) => r.id === repoId);

  useBackendEvents();
  useCloseGuard();
  useTheme(settings.theme);
  useAppearance(settings);
  const stashes = useStashes(repo && !repo.missing ? repo.id : null);
  useAutoFetch(Number(settings.autoFetchMinutes ?? 0));

  // 启动：读取设置；首次启动按系统语言（T-08）
  useEffect(() => {
    api.settings
      .getAll()
      .then((s) => {
        useApp.getState().setSettings(s);
        const lang = s.language || detectSystemLanguage();
        setLanguage(lang);
        if (!s.language) void api.settings.set('language', lang);
        if (s.lastRepo) useApp.getState().selectRepo(s.lastRepo);
      }, reportError)
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (ready) void api.settings.set('lastRepo', repoId ?? '');
  }, [repoId, ready]);

  // 已移除的仓库不再选中
  useEffect(() => {
    if (repos.data && repoId && !repos.data.some((r) => r.id === repoId)) useApp.getState().selectRepo(null);
  }, [repos.data, repoId]);

  // 全局快捷键（specs/06 第 9 节）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.cm-editor, .terminal-host')) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || useApp.getState().dialog || useApp.getState().confirm || useApp.getState().promptReq) return;
      const k = e.key.toLowerCase();
      // ⌘⇧` 分支弹窗（e.code 不受键盘布局影响）
      if (e.shiftKey && (e.code === 'Backquote' || k === '`' || k === '~') && repoId) {
        e.preventDefault();
        useApp.getState().openDialog({ type: 'branchPopup', repoId });
        return;
      }
      if (k === 'p' && !e.shiftKey) {
        e.preventDefault();
        useApp.getState().openDialog({ type: 'repoSwitcher' });
        return;
      }
      if (k === 'k' && e.shiftKey && repoId) {
        e.preventDefault();
        openPush(repoId);
      } else if (k === 't' && repoId) {
        e.preventDefault();
        void startPull(repoId);
      } else if (k === 'k' && !e.shiftKey && repoId) {
        setTab('changes');
      } else if (k === ',') {
        e.preventDefault();
        useApp.getState().openDialog({ type: 'settings' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [repoId, setTab]);

  const gitBad = info.data && !info.data.git.ok;

  return (
    <div className="app">
      <TopBar />
      {gitBad && (
        <div className="banner banner-warn" role="alert">
          <span>
            {info.data!.git.version ? t('settings.gitTooOld', { min: info.data!.git.minVersion }) : t('settings.gitNotFound')} —{' '}
            {info.data!.platform === 'windows' ? t('settings.gitInstallWin') : t('settings.gitInstallMac')}
          </span>
          <button onClick={() => useApp.getState().openDialog({ type: 'settings' })}>{t('top.settings')}</button>
        </div>
      )}
      <SplitView id="workspace" direction="column" initialSizes={[75, 25]} minSizes={[280, 100]} collapsed={bottomOpen ? undefined : { index: 1, size: 34 }}>
      <SplitView id="repositories" className="main" initialSizes={[20, 80]} minSizes={[180, 520]}>
        <Sidebar />
        <main className="content">
          {!repo ? (
            <Overview />
          ) : repo.missing ? (
            <p className="error-text pad">{t('errors.repo.missing', { path: repo.path })}</p>
          ) : (
            <>
              <nav className="tabs" role="tablist">
                {TABS.map((x) => (
                  <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>
                    {t(`nav.${x}`)}
                    {x === 'stash' && (stashes.data?.length ?? 0) > 0 && <span className="count-badge">{stashes.data!.length}</span>}
                  </button>
                ))}
              </nav>
              <div className="tab-content">
                {tab === 'changes' && <ChangesView key={repo.id} repoId={repo.id} />}
                {tab === 'files' && <FilesView key={repo.id} repoId={repo.id} />}
                {tab === 'branches' && <BranchesView key={repo.id} repoId={repo.id} />}
                {tab === 'log' && <LogView key={repo.id} repoId={repo.id} />}
                {tab === 'mapping' && <MappingView key={repo.id} repoId={repo.id} />}
                {tab === 'stash' && <StashView key={repo.id} repoId={repo.id} />}
              </div>
            </>
          )}
        </main>
      </SplitView>
      <BottomPanel />
      </SplitView>
      <Dialogs />
      <SyncDialogHost />
      <ConfirmHost />
      <PromptHost />
      <Toasts />
    </div>
  );
}
