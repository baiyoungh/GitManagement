import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTranslation } from 'react-i18next';
import { Eraser, ExternalLink, Plus, RotateCw, TerminalSquare, X } from 'lucide-react';
import { repoFolder } from '../lib/repoPaths';
import { useContextMenu } from './ui';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { reportError, useRepos } from '../api/queries';
import { useApp } from '../stores/appStore';
import { errorMessage } from '../lib/errors';
import { terminalInputChunks } from '../lib/terminalInput';

interface Session { id: string; repoId: string; number: number; name?: string }
type SessionStatus = 'starting' | 'running' | 'exited' | 'failed';
interface TerminalHandle { clear: () => void }

const TerminalPane = forwardRef<TerminalHandle, { session: Session; active: boolean; path: string; onStatus: (status: SessionStatus) => void }>(function TerminalPane({ session, active, path, onStatus }, ref) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerminal>();
  const fit = useRef<() => void>();
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [generation, setGeneration] = useState(0);
  const statusCallback = useRef(onStatus);
  statusCallback.current = onStatus;
  const [detail, setDetail] = useState('');
  const settings = useApp((s) => s.settings);
  useImperativeHandle(ref, () => ({
    clear: () => { terminal.current?.clear(); terminal.current?.focus(); },
  }), []);
  useEffect(() => { statusCallback.current(status); }, [status]);
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    setStatus('starting');
    setDetail('');
    const term = new XTerminal({ cursorBlink: true, scrollback: 5000, fontFamily: 'Menlo, Consolas, monospace', fontSize: 13, lineHeight: 1.25 });
    const applyTheme = () => {
      const css = getComputedStyle(element);
      const dark = document.documentElement.dataset.theme === 'dark';
      term.options.theme = {
        background: css.getPropertyValue('--bg').trim(), foreground: css.getPropertyValue('--fg').trim(),
        cursor: css.getPropertyValue('--fg').trim(), cursorAccent: css.getPropertyValue('--bg').trim(),
        selectionBackground: css.getPropertyValue('--selected').trim(),
        black: dark ? '#55575c' : '#24292f', brightBlack: dark ? '#9da0a8' : '#57606a',
        red: dark ? '#f2706b' : '#b42318', green: dark ? '#7bc78c' : '#116329',
        yellow: dark ? '#e2c275' : '#7d4e00', blue: dark ? '#82aaff' : '#174ea6',
        magenta: dark ? '#c9a2ed' : '#8250a0', cyan: dark ? '#71c9ce' : '#086f75',
        white: dark ? '#dfe1e5' : '#6e7781', brightWhite: dark ? '#ffffff' : '#1f2328',
        brightRed: dark ? '#ff9b95' : '#b42318', brightGreen: dark ? '#a1dfac' : '#116329',
        brightYellow: dark ? '#f0d89b' : '#7d4e00', brightBlue: dark ? '#adc8ff' : '#174ea6',
        brightMagenta: dark ? '#dfc0ff' : '#8250a0', brightCyan: dark ? '#9adfe3' : '#086f75',
      };
    };
    applyTheme();
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element);
    terminal.current = term;
    // Each mount owns its backend ID, including React's development remount.
    const id = crypto.randomUUID();
    let disposed = false;
    let opened = false;
    let ended = false;
    let frame = 0;
    let inputQueue = Promise.resolve();
    const resize = () => {
      if (!element.clientWidth || !element.clientHeight || disposed) return;
      addon.fit();
      if (opened && !ended) void api.terminal.resize(id, term.cols, term.rows).catch(() => undefined);
    };
    fit.current = resize;
    resize();
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(resize); });
    observer.observe(element);
    const input = term.onData((data) => {
      // Backend output can request a cursor report before the open call resolves.
      if (disposed || ended) return;
      // Serialize writes so rapid keystrokes/paste retain their order.
      for (const chunk of terminalInputChunks(data)) {
        inputQueue = inputQueue.then(() => disposed || ended ? undefined : api.terminal.input(id, chunk)).catch((e) => { if (!disposed) reportError(e); });
      }
    });
    void api.terminal.open(session.repoId, id, term.cols, term.rows, (event) => {
      if (disposed) return;
      if (event.type === 'data') term.write(new Uint8Array(event.data), () => {
        if (!disposed) void api.terminal.ack(id, event.data.length).catch(() => undefined);
      });
      else {
        ended = true;
        setStatus(event.type === 'exit' ? 'exited' : 'failed');
        setDetail(event.type === 'exit' ? String(event.code) : event.message);
      }
    }).then(() => {
      opened = true;
      if (disposed) { void api.terminal.close(id).catch(() => undefined); return; }
      if (!ended) setStatus('running');
      resize();
    }).catch((e) => {
      ended = true;
      if (!disposed) { setStatus('failed'); setDetail(errorMessage(e)); }
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = undefined;
      fit.current = undefined;
      if (opened) void api.terminal.close(id).catch(() => undefined);
    };
  }, [session.id, session.repoId, generation]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { fit.current?.(); terminal.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active, generation]);
  useEffect(() => {
    if (!terminal.current) return;
    terminal.current.options.fontFamily = settings['code.font'] || 'Menlo, Consolas, monospace';
    terminal.current.options.fontSize = Math.max(10, Math.min(24, Number(settings['code.fontSize']) || 13));
    fit.current?.();
  }, [settings['code.font'], settings['code.fontSize'], generation]);
  return <div className="terminal-pane" role="tabpanel" id={`terminal-pane-${session.id}`} aria-labelledby={`terminal-tab-${session.id}`} hidden={!active}>
    <div className="terminal-location">
      <span className={`terminal-status-dot ${status}`} aria-hidden="true" />
      <span className="terminal-path" title={path}>{path}</span>
      <span className={`terminal-state ${status === 'failed' ? 'error-text' : ''}`} role="status">{t(`terminal.${status}`)}{detail ? ` (${detail})` : ''}</span>
      {(status === 'exited' || status === 'failed') && <button className="terminal-restart" onClick={() => setGeneration((value) => value + 1)}><RotateCw size={13} />{t('terminal.restart')}</button>}
    </div>
    <div className="terminal-host" ref={host} />
  </div>;
});

export function TerminalPanel({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const repoId = useApp((s) => s.selectedRepoId);
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === repoId && !r.missing);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const initialized = useRef(new Set<string>());
  const counters = useRef<Record<string, number>>({});
  const handles = useRef(new Map<string, TerminalHandle>());
  const tabList = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const newSession = () => {
    if (!repo || sessions.length >= 12) return;
    initialized.current.add(repo.id);
    const number = counters.current[repo.id] = (counters.current[repo.id] ?? 0) + 1;
    const session = { id: crypto.randomUUID(), repoId: repo.id, number };
    setSessions((s) => [...s, session]);
    setSelected((s) => ({ ...s, [repo.id]: session.id }));
  };
  useEffect(() => {
    if (!visible || !repo || initialized.current.has(repo.id) || sessions.length >= 12) return;
    initialized.current.add(repo.id);
    const number = counters.current[repo.id] = (counters.current[repo.id] ?? 0) + 1;
    setSessions((old) => [...old, { id: crypto.randomUUID(), repoId: repo.id, number }]);
  }, [visible, repo?.id, sessions.length]);
  useEffect(() => {
    if (repos.data) setSessions((old) => old.filter((s) => repos.data!.some((r) => r.id === s.repoId && !r.missing)));
  }, [repos.data]);
  const current = sessions.filter((s) => s.repoId === repo?.id);
  const active = current.find((s) => s.id === selected[repoId ?? ''])?.id ?? current[current.length - 1]?.id;
  const label = (session: Session) => session.name || `${repoFolder(repos.data?.find((r) => r.id === session.repoId)?.path ?? '')}${session.number > 1 ? ` / ${session.number}` : ''}`;
  const close = (session: Session) => {
    const siblings = sessions.filter((s) => s.repoId === session.repoId);
    const index = siblings.findIndex((s) => s.id === session.id);
    if (active === session.id) setSelected((old) => ({ ...old, [session.repoId]: siblings[index + 1]?.id ?? siblings[index - 1]?.id ?? '' }));
    setSessions((old) => old.filter((s) => s.id !== session.id));
    setStatuses((old) => { const next = { ...old }; delete next[session.id]; return next; });
  };
  const rename = async (session: Session) => {
    const name = await useApp.getState().prompt({ title: t('terminal.rename'), label: t('terminal.name'), initial: label(session) });
    if (name) setSessions((old) => old.map((s) => s.id === session.id ? { ...s, name } : s));
  };
  useEffect(() => {
    if (!visible || !active) return;
    const tab = document.getElementById(`terminal-tab-${active}`)?.parentElement;
    const list = tabList.current;
    if (!tab || !list) return;
    const reveal = () => {
      if (tab.offsetLeft < list.scrollLeft) list.scrollLeft = tab.offsetLeft;
      else if (tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = tab.offsetLeft + tab.offsetWidth - list.clientWidth;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [active, visible, sessions]);
  return <div className="terminal-panel" hidden={!visible}>
    <div className="terminal-header">
      <div className="terminal-tabs" role="tablist" aria-label={t('terminal.sessions')} ref={tabList}>
        {current.map((s, index) => <div className={`terminal-tab ${active === s.id ? 'active' : ''}`} key={s.id}
          onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); close(s); } }}
          onContextMenu={(event) => menu.open(event, [
            { label: t('terminal.rename'), onClick: () => void rename(s) },
            { label: t('terminal.clear'), onClick: () => handles.current.get(s.id)?.clear() },
            { label: t('terminal.close'), onClick: () => close(s) },
          ])}>
          <button role="tab" id={`terminal-tab-${s.id}`} aria-controls={`terminal-pane-${s.id}`} aria-selected={active === s.id} tabIndex={active === s.id ? 0 : -1}
            title={`${label(s)} — ${t(`terminal.${statuses[s.id] ?? 'starting'}`)}`} onClick={() => setSelected((old) => ({ ...old, [s.repoId]: s.id }))}
            onDoubleClick={() => void rename(s)} onKeyDown={(event) => {
              if (event.key === 'Delete') { event.preventDefault(); close(s); }
              if (event.key === 'F2') { event.preventDefault(); void rename(s); }
              const next = event.key === 'ArrowRight' ? current[(index + 1) % current.length] : event.key === 'ArrowLeft' ? current[(index - 1 + current.length) % current.length] : event.key === 'Home' ? current[0] : event.key === 'End' ? current.at(-1) : undefined;
              if (next) { event.preventDefault(); setSelected((old) => ({ ...old, [s.repoId]: next.id })); document.getElementById(`terminal-tab-${next.id}`)?.focus(); }
            }}>
            <TerminalSquare size={14} /><span className="terminal-tab-name">{label(s)}</span>
            {(statuses[s.id] === 'failed' || statuses[s.id] === 'exited') && <span className={`terminal-status-dot ${statuses[s.id]}`} aria-hidden="true" />}
          </button>
          <button className="terminal-tab-close" title={t('terminal.closeNamed', { name: label(s) })} aria-label={t('terminal.closeNamed', { name: label(s) })} onClick={() => close(s)}><X size={13} /></button>
        </div>)}
      </div>
      <div className="terminal-actions">
        <button className="terminal-new" aria-label={t('terminal.new')} disabled={!repo || sessions.length >= 12} title={sessions.length >= 12 ? t('terminal.limit') : t('terminal.new')} onClick={newSession}><Plus size={15} /><span>{t('terminal.new')}</span></button>
        <span className="terminal-action-divider" />
        <button className="icon-btn" disabled={!active} title={t('terminal.clear')} aria-label={t('terminal.clear')} onClick={() => active && handles.current.get(active)?.clear()}><Eraser size={15} /></button>
        <button className="icon-btn" disabled={!repo} title={t('terminal.external')} aria-label={t('terminal.external')} onClick={() => repo && void api.external.open(repo.id, null, 'terminal').catch(reportError)}><ExternalLink size={15} /></button>
      </div>
    </div>
    {(!repo || !current.length) && <div className="terminal-empty"><TerminalSquare size={26} strokeWidth={1.4} />
      <strong>{t(repo ? 'terminal.noSession' : 'terminal.selectRepo')}</strong>
      {repo && <><span>{sessions.length >= 12 ? t('terminal.limit') : t('terminal.emptyHint', { name: repoFolder(repo.path) })}</span><button disabled={sessions.length >= 12} onClick={newSession}><Plus size={15} />{t('terminal.new')}</button></>}
    </div>}
    {sessions.map((s) => <TerminalPane key={s.id} session={s} path={repos.data?.find((r) => r.id === s.repoId)?.path ?? ''} active={visible && active === s.id}
      ref={(handle) => { if (handle) handles.current.set(s.id, handle); else handles.current.delete(s.id); }}
      onStatus={(status) => setStatuses((old) => old[s.id] === status ? old : { ...old, [s.id]: status })} />)}
    {menu.element}
  </div>;
}
