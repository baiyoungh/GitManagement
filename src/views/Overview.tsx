// 仓库总览（specs/06 第 2 节；R-05）。支持按分组筛选与勾选后批量操作（R-04、R-06）
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { RepoSummary, RepoView } from '../api/types';
import { reportError, useGroups, useRepos, useSummary } from '../api/queries';
import { useApp } from '../stores/appStore';
import { AheadBehind } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime, shortPath } from '../lib/format';
import { runBatch } from '../lib/batch';

type Filter = 'all' | 'dirty' | 'behind';

function matches(filter: Filter, d: RepoSummary | undefined) {
  if (filter === 'dirty') return !!d && d.changes > 0;
  if (filter === 'behind') return !!d && d.behind > 0;
  return true;
}

function Row({ repo, filter, checked, onCheck }: { repo: RepoView; filter: Filter; checked: boolean; onCheck: () => void }) {
  const { t } = useTranslation();
  const s = useSummary(repo.id, !repo.missing);
  const select = useApp((x) => x.selectRepo);
  const d = s.data;
  if (!matches(filter, d)) return null;
  const status = repo.missing || s.isError ? '⚠' : d?.operation ? '⚠' : d && d.changes > 0 ? '●' : '○';
  return (
    <tr onDoubleClick={() => select(repo.id)} className={checked ? 'selected' : undefined}>
      <td>
        <input type="checkbox" checked={checked} onChange={onCheck} aria-label={repo.name} />
      </td>
      <td>
        <button className="link" onClick={() => select(repo.id)}>
          {repo.favorite && <Icon name="star" size={12} filled className="star" style={{ marginRight: 4 }} />}
          {repo.name}
        </button>
      </td>
      <td className="mono muted" title={repo.path}>
        {shortPath(repo.path)}
      </td>
      <td>{d?.branch ?? d?.headShort ?? '-'}</td>
      <td>{d ? d.changes : '-'}</td>
      <td>{d ? <AheadBehind ahead={d.ahead} behind={d.behind} /> : '-'}</td>
      <td>{relativeTime(d?.lastCommitTime)}</td>
      <td
        title={
          repo.missing ? t('sidebar.missing') : d?.operation ? t(`status.operation.${d.operation}`) : d && d.changes > 0 ? t('status.dirty') : t('status.clean')
        }
      >
        {status === '⚠' ? <Icon name="warning" size={14} className="warn-text" /> : <Icon name={status === '●' ? 'dot' : 'circle'} size={14} className={status === '●' ? 'dirty-text' : 'muted'} />}
      </td>
    </tr>
  );
}

export function Overview() {
  const { t } = useTranslation();
  const repos = useRepos();
  const groups = useGroups();
  const [filter, setFilter] = useState<Filter>('all');
  const groupFilter = useApp((s) => s.overviewGroup);
  const showOverview = useApp((s) => s.showOverview);
  const multi = useApp((s) => s.multiSelected);
  const setMulti = useApp((s) => s.setMultiSelected);
  const openDialog = useApp((s) => s.openDialog);
  const known = new Set((groups.data ?? []).map((g) => g.id));
  const all = repos.data ?? [];
  const list = all.filter((r) =>
    groupFilter === undefined ? true : groupFilter === null ? !r.groupId || !known.has(r.groupId) : r.groupId === groupFilter,
  );
  const checked = list.filter((r) => multi.includes(r.id));
  const allChecked = list.length > 0 && checked.length === list.length;
  const targets = checked.length ? checked : list;
  const groupName = groupFilter === undefined ? null : groupFilter === null ? t('groups.ungrouped') : groups.data?.find((g) => g.id === groupFilter)?.name;

  return (
    <div className="overview">
      <div className="toolbar">
        <h2>{groupName ? `${groupName} (${list.length})` : t('overview.title', { count: list.length })}</h2>
        <select
          value={groupFilter === undefined ? '__all' : groupFilter === null ? '__none' : groupFilter}
          onChange={(e) => showOverview(e.target.value === '__all' ? undefined : e.target.value === '__none' ? null : e.target.value)}
          aria-label={t('groups.filter')}
        >
          <option value="__all">{t('groups.all')}</option>
          {(groups.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
          <option value="__none">{t('groups.ungrouped')}</option>
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="filter">
          <option value="all">{t('overview.filterAll')}</option>
          <option value="dirty">{t('overview.filterDirty')}</option>
          <option value="behind">{t('overview.filterBehind')}</option>
        </select>
        <button
          disabled={targets.length === 0}
          onClick={() => {
            if (checked.length === 0 && groupFilter === undefined) api.task.fetchAll().then(() => useApp.getState().setBottom(true, 'tasks'), reportError);
            else void runBatch('fetch', targets);
          }}
        >
          {checked.length ? t('batch.fetch', { count: checked.length }) : t('overview.fetchAll')}
        </button>
        <button disabled={targets.length === 0} onClick={() => void runBatch('pull', targets)}>
          {t('batch.pull', { count: targets.length })}
        </button>
        <button disabled={targets.length === 0} onClick={() => void runBatch('sync', targets)}>
          {t('batch.syncN', { count: targets.length })}
        </button>
        <span className="spacer" />
        <button onClick={() => openDialog({ type: 'addRepo' })}>{t('sidebar.addLocal')}</button>
        <button onClick={() => openDialog({ type: 'clone' })}>{t('sidebar.clone')}</button>
        <button onClick={() => openDialog({ type: 'scan' })}>{t('sidebar.scan')}</button>
      </div>
      {list.length === 0 ? (
        <p className="muted pad">{t('sidebar.empty')}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allChecked}
                  aria-label={t('batch.selectAll')}
                  onChange={() => setMulti(allChecked ? multi.filter((id) => !list.some((r) => r.id === id)) : [...new Set([...multi, ...list.map((r) => r.id)])])}
                />
              </th>
              <th>{t('overview.colName')}</th>
              <th>{t('overview.colPath')}</th>
              <th>{t('overview.colBranch')}</th>
              <th>{t('overview.colChanges')}</th>
              <th>{t('overview.colAheadBehind')}</th>
              <th>{t('overview.colLastCommit')}</th>
              <th>{t('overview.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <Row
                key={r.id}
                repo={r}
                filter={filter}
                checked={multi.includes(r.id)}
                onCheck={() => setMulti(multi.includes(r.id) ? multi.filter((x) => x !== r.id) : [...multi, r.id])}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
