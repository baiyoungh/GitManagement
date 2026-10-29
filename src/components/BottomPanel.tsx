// 底部面板：任务队列 + 命令日志（S-04、T-06）
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useApp } from '../stores/appStore';
import { useTasks } from '../stores/taskStore';
import { taskTitle } from '../lib/tasks';
import { errorMessage } from '../lib/errors';
import { Icon } from './Icon';

export function BottomPanel() {
  const { t } = useTranslation();
  const open = useApp((s) => s.bottomOpen);
  const tab = useApp((s) => s.bottomTab);
  const setBottom = useApp((s) => s.setBottom);
  const tasks = useTasks((s) => s.tasks);
  const logs = useTasks((s) => s.logs);
  const list = Object.values(tasks).sort((a, b) => b.startedAt - a.startedAt);
  const running = list.filter((x) => x.state === 'running' || x.state === 'queued');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && tab === 'log' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.length, open, tab]);

  const summary = running[0] ? `${taskTitle(running[0])}${running[0].percent != null ? ` ${running[0].percent}%` : ''}${running.length > 1 ? ` +${running.length - 1}` : ''}` : '';

  return (
    <section className={`bottom ${open ? 'open' : ''}`}>
      <div className="bottom-bar">
        <button className={tab === 'tasks' && open ? 'active' : ''} onClick={() => setBottom(!(open && tab === 'tasks'), 'tasks')}>
          {t('tasks.title')} {running.length > 0 && <span className="badge">{running.length}</span>}
        </button>
        <button className={tab === 'log' && open ? 'active' : ''} onClick={() => setBottom(!(open && tab === 'log'), 'log')}>
          {t('tasks.log')}
        </button>
        <span className="bottom-summary inline-icon">{summary && <Icon name="refresh" size={13} className="spin" />}{summary}</span>
        <button className="icon-btn" onClick={() => setBottom(!open)} aria-label={open ? t('common.collapse') : t('common.expand')} title={open ? t('common.collapse') : t('common.expand')}>
          <Icon name={open ? 'chevronDown' : 'chevronUp'} size={18} />
        </button>
      </div>
      {open && tab === 'tasks' && (
        <div className="bottom-content">
          <div className="bottom-tools">
            <button
              onClick={() => {
                void api.task.clear();
                useTasks.getState().clearFinished();
              }}
            >
              {t('tasks.clear')}
            </button>
          </div>
          {list.length === 0 && <p className="muted pad">{t('tasks.empty')}</p>}
          <ul className="task-list">
            {list.map((task) => (
              <li key={task.id} className={`task task-${task.state}`}>
                <span className="task-state">{t(`tasks.state.${task.state}`)}</span>
                <span className="task-title">{taskTitle(task)}</span>
                {task.state === 'running' && (
                  <progress max={100} value={task.percent ?? undefined} aria-label={taskTitle(task)} />
                )}
                <span className="task-msg mono">
                  {task.state === 'failed' ? errorMessage(task.error) : task.message}
                </span>
                {(task.state === 'running' || task.state === 'queued') && (
                  <button onClick={() => void api.task.cancel(task.id)}>{t('tasks.cancel')}</button>
                )}
                {task.state === 'failed' && task.error?.detail && (
                  <details className="task-detail">
                    <summary>{t('common.details')}</summary>
                    <pre>{task.error.detail}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && tab === 'log' && (
        <div className="bottom-content">
          <div className="bottom-tools">
            <button
              onClick={() => {
                void api.log.clear();
                useTasks.getState().setLogs([]);
              }}
            >
              {t('tasks.clearLog')}
            </button>
          </div>
          <div className="command-log mono" ref={logRef}>
            {logs.length === 0 && <p className="muted pad">{t('tasks.logEmpty')}</p>}
            {logs.map((l) => (
              <div key={l.id} className={`log-entry ${l.exitCode === 0 ? '' : 'log-fail'}`}>
                <div>
                  <span className="muted">{new Date(l.startedAt).toLocaleTimeString()}</span>{' '}
                  <span className="muted">[{l.cwd}]</span> {l.command}{' '}
                  <span className="muted">
                    ({l.exitCode ?? '×'}, {l.durationMs}ms)
                  </span>
                </div>
                {l.output && <pre>{l.output}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
