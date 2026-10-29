// 比较两个分支/提交（B-06），或某个版本与工作区（D-06）
import { useState } from 'react';
import { SplitView } from '../components/SplitView';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { CommitFile, LogCommit } from '../api/types';
import { DiffViewer, type DiffTarget } from './DiffViewer';
import { kindClass } from './StashView';
import { asFileChange } from '../lib/commitFile';
import { relativeTime } from '../lib/format';
import { errorMessage } from '../lib/errors';

function CommitList({ title, commits }: { title: string; commits: LogCommit[] }) {
  const { t } = useTranslation();
  return (
    <section className="compare-commits">
      <h4>
        {title} ({commits.length})
      </h4>
      {commits.length === 0 ? (
        <p className="muted small-text">{t('compare.none')}</p>
      ) : (
        <ul>
          {commits.map((c) => (
            <li key={c.hash} title={c.hash}>
              <span className="mono muted">{c.shortHash}</span> {c.subject} <span className="muted small-text">· {c.authorName} · {relativeTime(c.authorTime)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** right = null 表示工作区 */
export function ComparePanel({ repoId, left, right }: { repoId: string; left: string; right: string | null }) {
  const { t } = useTranslation();
  const [file, setFile] = useState<CommitFile | null>(null);
  const q = useQuery({
    queryKey: ['repo', repoId, 'compare', left, right],
    queryFn: async () => {
      if (right === null) return { onlyLeft: [], onlyRight: [], truncated: false, files: await api.compare.files(repoId, left, null) };
      return api.compare.refs(repoId, left, right);
    },
  });
  const target: DiffTarget | null = file
    ? {
        repoId,
        file: asFileChange(file),
        left: { kind: 'commit', rev: left },
        right: right === null ? { kind: 'worktree' } : { kind: 'commit', rev: right },
      }
    : null;
  const rightLabel = right ?? t('diff.worktree');

  if (q.isLoading) return <p className="muted pad">{t('common.loading')}</p>;
  if (q.isError) return <p className="error-text pad">{errorMessage(q.error)}</p>;
  const d = q.data!;
  return (
    <SplitView id={right === null ? 'compare-worktree' : 'compare'} className="compare" direction="column" initialSizes={[30, 70]} minSizes={[90, 160]}>
      {right !== null && (
        <div className="compare-top">
          <SplitView id="compare-commits" initialSizes={[50, 50]} minSizes={[100, 100]}>
          <CommitList title={t('compare.onlyIn', { name: right })} commits={d.onlyRight} />
          <CommitList title={t('compare.onlyIn', { name: left })} commits={d.onlyLeft} />
          </SplitView>
          {d.truncated && <p className="warn-text small-text">{t('compare.truncated')}</p>}
        </div>
      )}
      <SplitView id="compare-files" className="compare-files" initialSizes={[35, 65]} minSizes={[160, 200]}>
        <div className="commit-files">
          <h4>{t('compare.files', { count: d.files.length, left, right: rightLabel })}</h4>
          <ul>
            {d.files.map((f) => (
              <li key={f.path}>
                <button className={`file-btn ${file?.path === f.path ? 'selected' : ''}`} onClick={() => setFile(f)}>
                  <span className={`kind kind-${kindClass(f.status)}`}>{f.status}</span>
                  <span className="mono">
                    {f.oldPath ? `${f.oldPath} → ` : ''}
                    {f.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="compare-diff">{target ? <DiffViewer target={target} /> : <p className="muted pad">{t('diff.selectFile')}</p>}</div>
      </SplitView>
    </SplitView>
  );
}
