// 设置（specs/06 第 8 节）：通用、语言、Git、身份、凭据、外观
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { ConfigScope, GitInfo, Identity } from '../api/types';
import { keys, reportError, useAppInfo, useRepos } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field, Modal } from '../components/ui';
import { Icon } from '../components/Icon';
import { LANGUAGES, setLanguage } from '../i18n';
import { errorMessage } from '../lib/errors';

type Section = 'general' | 'language' | 'git' | 'identity' | 'credentials' | 'appearance' | 'external' | 'precheck' | 'shortcuts';

function useSetting() {
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSetting);
  return {
    settings,
    set: (k: string, v: string) => {
      patch(k, v);
      api.settings.set(k, v).catch(reportError);
    },
  };
}

function GeneralSection() {
  const { t } = useTranslation();
  const { settings, set } = useSetting();
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={settings.autoRefresh !== 'false'} onChange={(e) => set('autoRefresh', String(e.target.checked))} />
        {t('settings.autoRefresh')}
      </label>
      <Field label={t('settings.autoFetch')}>
        <input type="number" min={0} value={settings.autoFetchMinutes ?? '0'} onChange={(e) => set('autoFetchMinutes', String(Math.max(0, Number(e.target.value) || 0)))} />
      </Field>
      <Field label={t('settings.pullStrategy')}>
        <select value={settings.pullStrategy ?? 'merge'} onChange={(e) => set('pullStrategy', e.target.value)}>
          <option value="merge">{t('settings.pullMerge')}</option>
          <option value="rebase">{t('settings.pullRebase')}</option>
          <option value="ffOnly">{t('settings.pullFfOnly')}</option>
        </select>
      </Field>
    </>
  );
}

function LanguageSection() {
  const { t, i18n } = useTranslation();
  const { set } = useSetting();
  return (
    <Field label={t('settings.languageLabel')}>
      <select
        value={i18n.language}
        onChange={(e) => {
          setLanguage(e.target.value);
          set('language', e.target.value);
        }}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function GitSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = useAppInfo();
  const { settings } = useSetting();
  const [path, setPath] = useState(settings.gitPath ?? '');
  const [git, setGit] = useState<GitInfo | null>(null);
  const g = git ?? info.data?.git;

  const apply = async () => {
    try {
      const r = await api.app.setGitPath(path.trim() || null);
      setGit(r);
      useApp.getState().patchSetting('gitPath', path.trim());
      void qc.invalidateQueries({ queryKey: keys.appInfo });
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <>
      <Field label={t('settings.gitPath')} hint={t('settings.gitAuto')}>
        <div className="input-row">
          <input value={path} onChange={(e) => setPath(e.target.value)} className="mono" placeholder={g?.path} />
          <button onClick={apply}>{t('common.apply')}</button>
        </div>
      </Field>
      <dl className="kv">
        <dt>{t('settings.gitVersion')}</dt>
        <dd>
          {g?.version ? <span className="mono">{g.version}</span> : <span className="error-text">{t('settings.gitNotFound')}</span>}{' '}
          {g && (g.ok ? <span className="ok-text inline-icon"><Icon name="check" size={14} /> {t('settings.gitOk')}</span> : g.version && <span className="error-text">{t('settings.gitTooOld', { min: g.minVersion })}</span>)}
        </dd>
        <dt>path</dt>
        <dd className="mono">{g?.path}</dd>
      </dl>
      {g && !g.ok && <p className="muted">{info.data?.platform === 'windows' ? t('settings.gitInstallWin') : t('settings.gitInstallMac')}</p>}
      {g?.error && <p className="error-text">{errorMessage(g.error)}</p>}
    </>
  );
}

function IdentityForm({ repoId, scope, title }: { repoId: string | null; scope: ConfigScope; title: string }) {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const [id, setId] = useState<Identity>({ name: '', email: '' });
  useEffect(() => {
    api.identity.get(repoId, scope).then(
      (r) => setId({ name: r.name ?? '', email: r.email ?? '' }),
      () => undefined,
    );
  }, [repoId, scope]);
  return (
    <fieldset>
      <legend>{title}</legend>
      <div className="field-row">
        <Field label={t('settings.name')}>
          <input value={id.name ?? ''} onChange={(e) => setId({ ...id, name: e.target.value })} />
        </Field>
        <Field label={t('settings.email')}>
          <input value={id.email ?? ''} onChange={(e) => setId({ ...id, email: e.target.value })} />
        </Field>
      </div>
      <button onClick={() => api.identity.set(repoId, scope, id).then(() => toast('success', t('settings.saved')), reportError)}>{t('common.save')}</button>
    </fieldset>
  );
}

function IdentitySection() {
  const { t } = useTranslation();
  const repoId = useApp((s) => s.selectedRepoId);
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === repoId);
  return (
    <>
      <IdentityForm repoId={null} scope="global" title={t('settings.identityGlobal')} />
      {repo && !repo.missing && <IdentityForm repoId={repo.id} scope="local" title={t('settings.identityRepo', { name: repo.name })} />}
    </>
  );
}

function CredentialSection() {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [secret, setSecret] = useState('');
  const [existing, setExisting] = useState<string | null>(null);

  useEffect(() => {
    if (!/^https?:\/\/[^/]+/i.test(url.trim())) {
      setExisting(null);
      return;
    }
    const h = setTimeout(() => api.credential.getUser(url.trim()).then(setExisting, () => setExisting(null)), 300);
    return () => clearTimeout(h);
  }, [url]);

  return (
    <>
      <p className="muted">{t('settings.credNote')}</p>
      <Field label={t('settings.credUrl')}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} className="mono" />
      </Field>
      {existing && <p className="muted">{t('settings.credExisting', { user: existing })}</p>}
      <div className="field-row">
        <Field label={t('settings.credUser')}>
          <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
        </Field>
        <Field label={t('settings.credToken')}>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <div className="action-row">
        <button
          className="primary"
          disabled={!url.trim() || !user.trim() || !secret}
          onClick={() =>
            api.credential.save(url.trim(), user.trim(), secret).then(() => {
              setSecret('');
              setExisting(user.trim());
              toast('success', t('settings.credSaved'));
            }, reportError)
          }
        >
          {t('settings.credSave')}
        </button>
        <button
          className="danger"
          disabled={!existing}
          onClick={() =>
            api.credential.delete(url.trim()).then(() => {
              setExisting(null);
              toast('success', t('settings.credDeleted'));
            }, reportError)
          }
        >
          {t('settings.credDelete')}
        </button>
      </div>
    </>
  );
}

/** 外观（T-04）：主题、字体、字号、差异颜色 */
export const DIFF_COLOR_KEYS = ['add', 'rem', 'chg'] as const;

function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, set } = useSetting();
  return (
    <>
      <Field label={t('settings.theme')}>
        <select value={settings.theme ?? 'system'} onChange={(e) => set('theme', e.target.value)}>
          <option value="system">{t('settings.themeSystem')}</option>
          <option value="light">{t('settings.themeLight')}</option>
          <option value="dark">{t('settings.themeDark')}</option>
        </select>
      </Field>
      <div className="field-row">
        <Field label={t('settings.uiFontSize')}>
          <input type="number" min={11} max={18} value={settings['ui.fontSize'] ?? '13'} onChange={(e) => set('ui.fontSize', String(Math.max(11, Math.min(18, Number(e.target.value) || 13))))} />
        </Field>
        <Field label={t('settings.codeFontSize')}>
          <input type="number" min={10} max={20} value={settings['code.fontSize'] ?? '12'} onChange={(e) => set('code.fontSize', String(Math.max(10, Math.min(20, Number(e.target.value) || 12))))} />
        </Field>
      </div>
      <Field label={t('settings.codeFont')} hint={t('settings.codeFontHint')}>
        <input className="mono" value={settings['code.font'] ?? ''} placeholder="JetBrains Mono, Menlo, Consolas" onChange={(e) => set('code.font', e.target.value)} />
      </Field>
      <fieldset>
        <legend>{t('settings.diffColors')}</legend>
        <div className="field-row">
          {DIFF_COLOR_KEYS.map((k) => (
            <Field key={k} label={t(`settings.diffColor_${k}`)}>
              <div className="input-row">
                <input type="color" value={settings[`diff.color.${k}`] || { add: '#2da44e', rem: '#cf222e', chg: '#2f6feb' }[k]} onChange={(e) => set(`diff.color.${k}`, e.target.value)} />
                {settings[`diff.color.${k}`] && (
                  <button className="small" onClick={() => set(`diff.color.${k}`, '')}>
                    {t('settings.reset')}
                  </button>
                )}
              </div>
            </Field>
          ))}
        </div>
        <p className="muted small-text">{t('settings.diffColorsHint')}</p>
      </fieldset>
    </>
  );
}

/** 外部工具（R-08）：终端、编辑器 / IDE */
function ExternalSection() {
  const { t } = useTranslation();
  const { settings, set } = useSetting();
  const info = useAppInfo();
  const mac = info.data?.platform === 'macos';
  return (
    <>
      <Field label={t('settings.terminalApp')} hint={mac ? t('settings.terminalHintMac') : t('settings.terminalHintWin')}>
        <input className="mono" value={settings.terminalApp ?? ''} placeholder={mac ? 'Terminal / iTerm' : 'wt.exe / pwsh.exe'} onChange={(e) => set('terminalApp', e.target.value)} />
      </Field>
      <Field label={t('settings.editorApp')} hint={mac ? t('settings.editorHintMac') : t('settings.editorHintWin')}>
        <input className="mono" value={settings.editorApp ?? ''} placeholder={mac ? 'Visual Studio Code / IntelliJ IDEA' : 'code.cmd / idea64.exe'} onChange={(e) => set('editorApp', e.target.value)} />
      </Field>
    </>
  );
}

/** 提交前检查（specs/04 第 2.3 节） */
function PrecheckSection() {
  const { t } = useTranslation();
  const { settings, set } = useSetting();
  const enabled = settings['precheck.enabled'] !== 'false';
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => set('precheck.enabled', String(e.target.checked))} />
        {t('settings.precheckEnabled')}
      </label>
      <Field label={t('settings.precheckLarge')}>
        <input type="number" min={0} disabled={!enabled} value={settings['precheck.largeFileMb'] ?? '10'} onChange={(e) => set('precheck.largeFileMb', String(Math.max(0, Number(e.target.value) || 0)))} />
      </Field>
      <label className="check">
        <input type="checkbox" disabled={!enabled} checked={settings['precheck.secrets'] !== 'false'} onChange={(e) => set('precheck.secrets', String(e.target.checked))} />
        {t('settings.precheckSecrets')}
      </label>
      <label className="check">
        <input type="checkbox" disabled={!enabled} checked={settings['precheck.todo'] === 'true'} onChange={(e) => set('precheck.todo', String(e.target.checked))} />
        {t('settings.precheckTodo')}
      </label>
      <p className="muted small-text">{t('settings.precheckNote')}</p>
    </>
  );
}

/** 快捷键（T-05，对齐 JetBrains；specs/06 第 9 节） */
function ShortcutsSection() {
  const { t } = useTranslation();
  const rows: [string, string, string][] = [
    ['commit', '⌘K', 'Ctrl+K'],
    ['push', '⌘⇧K', 'Ctrl+Shift+K'],
    ['pull', '⌘T', 'Ctrl+T'],
    ['diff', '⌘D', 'Ctrl+D'],
    ['rollback', '⌘⌥Z', 'Ctrl+Alt+Z'],
    ['nextDiff', 'F7 / ⇧F7', 'F7 / Shift+F7'],
    ['branches', '⌘⇧`', 'Ctrl+Shift+`'],
    ['switchRepo', '⌘P', 'Ctrl+P'],
    ['refresh', '⌘R', 'Ctrl+R'],
    ['settings', '⌘,', 'Ctrl+,'],
  ];
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>{t('settings.shortcutAction')}</th>
          <th>macOS</th>
          <th>Windows</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, m, w]) => (
          <tr key={k}>
            <td>{t(`settings.sc_${k}`)}</td>
            <td className="mono">{m}</td>
            <td className="mono">{w}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SettingsDialog() {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const [section, setSection] = useState<Section>('general');
  const sections: Section[] = ['general', 'language', 'git', 'identity', 'credentials', 'appearance', 'external', 'precheck', 'shortcuts'];
  return (
    <Modal title={t('settings.title')} onClose={close} width={760}>
      <div className="settings">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {sections.map((s) => (
            <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)} aria-current={section === s ? 'page' : undefined}>
              {t(`settings.${s}`)}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {section === 'general' && <GeneralSection />}
          {section === 'language' && <LanguageSection />}
          {section === 'git' && <GitSection />}
          {section === 'identity' && <IdentitySection />}
          {section === 'credentials' && <CredentialSection />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'external' && <ExternalSection />}
          {section === 'precheck' && <PrecheckSection />}
          {section === 'shortcuts' && <ShortcutsSection />}
        </div>
      </div>
    </Modal>
  );
}
