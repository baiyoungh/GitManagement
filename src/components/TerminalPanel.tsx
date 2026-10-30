import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTranslation } from 'react-i18next';
import { Eraser, ExternalLink, Plus, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { reportError, useRepos } from '../api/queries';
import { useApp } from '../stores/appStore';
import { errorMessage } from '../lib/errors';
import { terminalInputChunks } from '../lib/terminalInput';

interface Session { id: string; repoId: string; number: number }

function TerminalPane({ session, active, path, onClose }: { session: Session; active: boolean; path: string; onClose: () => void }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerminal>();
  const fit = useRef<() => void>();
  const [status, setStatus] = useState('starting');
  const [detail, setDetail] = useState('');
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const term = new XTerminal({ cursorBlink: true, scrollback: 5000, fontFamily: 'Menlo, Consolas, monospace', fontSize: 12,
      theme: { background: '#151719', foreground: '#e5e7eb', cursor: '#e5e7eb', selectionBackground: '#415c70' } });
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
      if (!opened || ended) return;
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
      if (!disposed) { setStatus('failed'); setDetail(errorMessage(e)); }
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = undefined;
      fit.current = undefined;
      if (opened) void api.terminal.close(id).catch(() => undefined);
    };
  }, [session.id, session.repoId]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { fit.current?.(); terminal.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => {
    if (!terminal.current) return;
    terminal.current.options.fontFamily = settings['code.font'] || 'Menlo, Consolas, monospace';
    terminal.current.options.fontSize = Math.max(10, Math.min(24, Number(settings['code.fontSize']) || 12));
    fit.current?.();
  }, [settings['code.font'], settings['code.fontSize']]);
  return <div className="terminal-pane" hidden={!active}>
    <div className="terminal-toolbar">
      <span className="mono terminal-path" title={path}>{path}</span>
      <span className={`small-text ${status === 'failed' ? 'error-text' : 'muted'}`} role="status">{t(`terminal.${status}`)}{detail ? ` (${detail})` : ''}</span>
      <span className="spacer" />
      <button className="icon-btn" title={t('terminal.clear')} aria-label={t('terminal.clear')} onClick={() => terminal.current?.clear()}><Eraser size={15} /></button>
      <button className="icon-btn" title={t('terminal.close')} aria-label={t('terminal.close')} onClick={onClose}><X size={15} /></button>
    </div>
    <div className="terminal-host" ref={host} />
  </div>;
}

export function TerminalPanel({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const repoId = useApp((s) => s.selectedRepoId);
  const repos = useRepos();
  const repo = repos.data?.find((r) => r.id === repoId && !r.missing);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const counter = useRef(0);
  const newSession = () => {
    if (!repo) return;
    const session = { id: crypto.randomUUID(), repoId: repo.id, number: ++counter.current };
    setSessions((s) => [...s, session]);
    setSelected((s) => ({ ...s, [repo.id]: session.id }));
  };
  useEffect(() => {
    if (visible && repo) setSessions((old) => old.some((s) => s.repoId === repo.id) ? old : [...old, { id: crypto.randomUUID(), repoId: repo.id, number: ++counter.current }]);
  }, [visible, repo?.id]);
  useEffect(() => {
    if (repos.data) setSessions((old) => old.filter((s) => repos.data!.some((r) => r.id === s.repoId && !r.missing)));
  }, [repos.data]);
  const current = sessions.filter((s) => s.repoId === repo?.id);
  const active = current.find((s) => s.id === selected[repoId ?? ''])?.id ?? current[current.length - 1]?.id;
  return <div className="terminal-panel" hidden={!visible}>
    <div className="terminal-tabs">
      {current.map((s) => <button key={s.id} className={active === s.id ? 'active' : ''} onClick={() => setSelected((old) => ({ ...old, [s.repoId]: s.id }))}>{t('terminal.session', { n: s.number })}</button>)}
      <span className="spacer" />
      <button className="icon-btn" disabled={!repo || sessions.length >= 12} title={t('terminal.new')} aria-label={t('terminal.new')} onClick={newSession}><Plus size={16} /></button>
      <button className="icon-btn" disabled={!repo} title={t('terminal.external')} aria-label={t('terminal.external')} onClick={() => repo && void api.external.open(repo.id, null, 'terminal').catch(reportError)}><ExternalLink size={15} /></button>
    </div>
    {!repo && <p className="muted pad">{t('terminal.selectRepo')}</p>}
    {repo && current.length === 0 && <p className="muted pad">{t('terminal.noSession')}</p>}
    {sessions.map((s) => <TerminalPane key={s.id} session={s} path={repos.data?.find((r) => r.id === s.repoId)?.path ?? ''} active={visible && active === s.id}
      onClose={() => setSessions((old) => old.filter((x) => x.id !== s.id))} />)}
  </div>;
}
