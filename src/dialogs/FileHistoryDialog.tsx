// 文件历史与 Blame（L-05）
import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BlameCommit, FileHistoryEntry } from '../api/types';
import { useApp } from '../stores/appStore';
import { Modal } from '../components/ui';
import { SplitView } from '../components/SplitView';
import { DiffViewer, type DiffTarget } from '../views/DiffViewer';
import { dateTime, relativeTime } from '../lib/format';
import { errorMessage } from '../lib/errors';
import { EMPTY_TREE, asFileChange } from '../lib/commitFile';

/** 按提交哈希生成稳定的色相，便于区分 blame 中的不同提交 */
function hue(hash: string) {
  let h = 0;
  for (let i = 0; i < 8; i++) h = (h * 31 + hash.charCodeAt(i)) % 360;
  return h;
}

export function FileHistoryDialog({ repoId, path, mode: initial }: { repoId: string; path: string; mode: 'history' | 'blame' }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const [mode, setMode] = useState(initial);
  const [selected, setSelected] = useState<FileHistoryEntry | null>(null);
  const [blameRev, setBlameRev] = useState<string | null>(null);

  const hist = useInfiniteQuery({
    queryKey: ['repo', repoId, 'fileHistory', path],
    queryFn: ({ pageParam }) => api.history.fileHistory(repoId, path, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.entries.length, 0) : undefined),
  });
  const entries = useMemo(() => hist.data?.pages.flatMap((p) => p.entries) ?? [], [hist.data]);

  const blamePath = blameRev ? entries.find((e) => e.commit.hash === blameRev)?.path ?? path : path;
  const blame = useQuery({
    queryKey: ['repo', repoId, 'blame', blamePath, blameRev],
    queryFn: () => api.history.blame(repoId, blamePath, blameRev),
    enabled: mode === 'blame',
  });
  const commitsByHash = useMemo(() => new Map<string, BlameCommit>((blame.data?.commits ?? []).map((c) => [c.hash, c])), [blame.data]);

  const target: DiffTarget | null = selected
    ? {
        repoId,
        file: asFileChange({ status: selected.status, path: selected.path, oldPath: selected.oldPath }),
        left: { kind: 'commit', rev: selected.commit.parents[0] ?? EMPTY_TREE },
        right: { kind: 'commit', rev: selected.commit.hash },
      }
    : null;

  return (
    <Modal title={`${t(mode === 'blame' ? 'history.blameTitle' : 'history.title')} — ${path}`} onClose={close} width={1100}>
      <div className="toolbar small">
        <div className="seg" role="group">
          <button className={mode === 'history' ? 'active' : ''} onClick={() => setMode('history')}>
            {t('history.history')}
          </button>
          <button className={mode === 'blame' ? 'active' : ''} onClick={() => setMode('blame')}>
            Blame
          </button>
        </div>
        {mode === 'blame' && (
          <select value={blameRev ?? ''} onChange={(e) => setBlameRev(e.target.value || null)} aria-label={t('history.blameAt')}>
            <option value="">{t('history.blameWorktree')}</option>
            {entries
              .filter((e) => e.status !== 'D')
              .map((e) => (
                <option key={e.commit.hash} value={e.commit.hash}>
                  {e.commit.shortHash} {e.commit.subject.slice(0, 60)}
                </option>
              ))}
          </select>
        )}
      </div>
      {mode === 'history' ? (
        <SplitView id="file-history" className="history-body" initialSizes={[35, 65]} minSizes={[200, 240]}>
          <ul className="history-list" role="listbox" aria-label={t('history.history')}>
            {hist.isLoading && <li className="muted pad">{t('common.loading')}</li>}
            {hist.isError && <li className="error-text pad">{errorMessage(hist.error)}</li>}
            {entries.map((e) => (
              <li key={e.commit.hash}>
                <button
                  role="option"
                  aria-selected={selected?.commit.hash === e.commit.hash}
                  className={`history-row ${selected?.commit.hash === e.commit.hash ? 'selected' : ''}`}
                  onClick={() => setSelected(e)}
                >
                  <span className="mono muted">{e.commit.shortHash}</span>
                  <span className="history-subject">
                    {e.commit.subject}
                    {e.oldPath && <span className="muted"> ({e.oldPath} → {e.path})</span>}
                  </span>
                  <span className="muted small-text">
                    {e.commit.authorName} · <span title={dateTime(e.commit.authorTime)}>{relativeTime(e.commit.authorTime)}</span>
                  </span>
                </button>
              </li>
            ))}
            {hist.hasNextPage && (
              <li>
                <button className="link pad" disabled={hist.isFetchingNextPage} onClick={() => void hist.fetchNextPage()}>
                  {t('history.more')}
                </button>
              </li>
            )}
          </ul>
          <div className="history-diff">{target ? <DiffViewer target={target} /> : <p className="muted pad">{t('log.selectCommit')}</p>}</div>
        </SplitView>
      ) : (
        <div className="blame mono">
          {blame.isLoading && <p className="muted pad">{t('common.loading')}</p>}
          {blame.isError && <p className="error-text pad">{errorMessage(blame.error)}</p>}
          {blame.data?.lines.map((l, i) => {
            const c = commitsByHash.get(l.hash);
            const first = i === 0 || blame.data!.lines[i - 1].hash !== l.hash;
            return (
              <div key={i} className="blame-row" style={{ borderLeftColor: c?.uncommitted ? 'var(--warn)' : `hsl(${hue(l.hash)} 55% 55%)` }}>
                <span className="blame-info" title={c ? `${c.hash.slice(0, 10)} ${c.authorName} <${c.authorEmail}>\n${dateTime(c.authorTime)}\n${c.summary}` : ''}>
                  {first && c && (c.uncommitted ? t('history.uncommitted') : `${c.hash.slice(0, 7)} ${c.authorName.slice(0, 14)} ${relativeTime(c.authorTime)}`)}
                </span>
                <span className="ln">{i + 1}</span>
                <span className="blame-code">{l.content || ' '}</span>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
