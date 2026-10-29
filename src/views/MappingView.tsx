// 远端映射标签页（specs/03 第 4 节；M-01 ~ M-05）
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BranchMapping, PlannedTarget, RemoteInfo, SyncRule } from '../api/types';
import { invalidateRepo, reportError, useRemotes } from '../api/queries';
import { useApp } from '../stores/appStore';
import { AheadBehind, useContextMenu, type MenuItem } from '../components/ui';
import { Icon } from '../components/Icon';
import { RemoteDialog } from '../dialogs/RemoteDialog';
import { RuleDrawer } from '../dialogs/RuleDrawer';
import { errorMessage } from '../lib/errors';
import { openSyncPreview } from '../dialogs/SyncDialog';

type Filter = 'all' | 'rules' | 'noUpstream' | 'diff' | 'mismatch';

export function useMapping(repoId: string) {
  return useQuery({ queryKey: ['repo', repoId, 'mapping'], queryFn: () => api.sync.mapping(repoId) });
}

export function useRules(repoId: string) {
  return useQuery({ queryKey: ['repo', repoId, 'rules'], queryFn: () => api.sync.rules(repoId) });
}

function TargetStatus({ t: tg }: { t: PlannedTarget }) {
  const { t } = useTranslation();
  if (!tg.enabled) return <span className="muted">{t('mapping.disabled')}</span>;
  if (tg.remoteMissing) return <span className="error-text inline-icon"><Icon name="warning" size={13} /> {t('mapping.remoteMissing')}</span>;
  if (tg.url) return <span className="muted">{t('mapping.urlTarget')}</span>;
  if (tg.remoteBranchExists === false) return <span className="warn-text">{t('mapping.remoteBranchMissing')}</span>;
  const a = tg.ahead ?? 0;
  const b = tg.behind ?? 0;
  if (a === 0 && b === 0) return <span className="ok-text inline-icon"><Icon name="check" size={13} /> {t('mapping.synced')}</span>;
  return (
    <span className={`inline-icon ${a > 0 && b > 0 ? 'warn-text' : ''}`} title={a > 0 && b > 0 ? t('mapping.diverged') : undefined}>
      {a > 0 && (
        <>
          <Icon name="arrowUp" size={12} />
          {a}{' '}
        </>
      )}
      {b > 0 && (
        <>
          <Icon name="arrowDown" size={12} />
          {b}
        </>
      )}
      {a > 0 && b > 0 && <Icon name="warning" size={13} style={{ marginLeft: 4 }} />}
    </span>
  );
}

function targetLabel(tg: { remote: string | null; url: string | null; remoteBranch: string }) {
  return `${tg.remote ?? tg.url ?? '?'}/${tg.remoteBranch}`;
}

export function MappingView({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const remotes = useRemotes(repoId);
  const mapping = useMapping(repoId);
  const rules = useRules(repoId);
  const ask = useApp((s) => s.ask);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const menu = useContextMenu();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [remoteDialog, setRemoteDialog] = useState<{ remote: RemoteInfo | null } | null>(null);
  const [drawer, setDrawer] = useState<{ rule: SyncRule | null; branch?: string } | null>(null);
  const [testing, setTesting] = useState<Record<string, 'pending' | 'ok' | 'fail'>>({});
  const [testErr, setTestErr] = useState<Record<string, string>>({});

  // M-07：进入页面时自动检测所有 remote 的连通性（结果缓存 10 分钟，不随文件变化刷新）
  const health = useQuery({
    queryKey: ['remoteHealth', repoId, (remotes.data ?? []).map((r) => `${r.name}=${r.fetchUrl}`).join('|')],
    queryFn: () => api.health.remotes(repoId),
    enabled: settings['mapping.autoCheck'] !== 'false' && (remotes.data?.length ?? 0) > 0,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!health.data) return;
    setTesting((s) => {
      const n = { ...s };
      for (const h of health.data) if (n[h.name] !== 'pending') n[h.name] = h.result.ok ? 'ok' : 'fail';
      return n;
    });
    setTestErr((s) => {
      const n = { ...s };
      for (const h of health.data) n[h.name] = h.result.error ? errorMessage(h.result.error) : '';
      return n;
    });
  }, [health.data]);
  const unreachable = Object.entries(testing).filter(([, v]) => v === 'fail').map(([k]) => k);

  const refresh = () => invalidateRepo(repoId);
  const ruleById = useMemo(() => new Map((rules.data ?? []).map((r) => [r.id, r])), [rules.data]);

  const rows = (mapping.data ?? []).filter((m) => {
    if (query && !m.branch.toLowerCase().includes(query.toLowerCase())) return false;
    switch (filter) {
      case 'rules':
        return !!m.ruleId;
      case 'noUpstream':
        return !m.upstream;
      case 'diff':
        return m.ahead > 0 || m.behind > 0 || m.targets.some((x) => (x.ahead ?? 0) > 0 || (x.behind ?? 0) > 0 || x.remoteBranchExists === false);
      case 'mismatch':
        return (
          m.upstreamState === 'mismatch' ||
          m.upstreamGone ||
          m.targets.some((x) => x.remoteMissing || (x.remote && unreachable.includes(x.remote)) || x.remoteBranchExists === false)
        );
      default:
        return true;
    }
  });

  const testRemote = async (name: string) => {
    setTesting((s) => ({ ...s, [name]: 'pending' }));
    try {
      const r = await api.remoteAdmin.test(repoId, name);
      setTesting((s) => ({ ...s, [name]: r.ok ? 'ok' : 'fail' }));
      setTestErr((s) => ({ ...s, [name]: r.error ? errorMessage(r.error) : '' }));
    } catch (e) {
      setTesting((s) => ({ ...s, [name]: 'fail' }));
      setTestErr((s) => ({ ...s, [name]: errorMessage(e) }));
    }
  };

  const removeRemote = async (r: RemoteInfo) => {
    const used = (rules.data ?? []).some((x) => x.targets.some((tg) => tg.remote === r.name));
    const ok = await ask({
      title: t('mapping.removeRemoteTitle', { name: r.name }),
      body: t('mapping.removeRemoteBody', { name: r.name }),
      note: used ? t('mapping.removeRemoteUsed') : undefined,
      danger: true,
      confirmLabel: t('common.delete'),
    });
    if (!ok) return;
    api.remoteAdmin.remove(repoId, r.name).then(refresh, reportError);
  };

  const resolveMismatch = async (m: BranchMapping, prefer: 'git' | 'rule') => {
    try {
      await api.sync.resolveUpstream(repoId, m.branch, prefer);
      toast('success', t('branches.upstreamSet'));
    } catch (e) {
      reportError(e);
    } finally {
      refresh();
    }
  };

  const updateTarget = async (ruleId: string, targetId: string, change: 'disable' | 'enable' | 'delete') => {
    const rule = ruleById.get(ruleId);
    if (!rule) return;
    const next: SyncRule = {
      ...rule,
      targets:
        change === 'delete'
          ? rule.targets.filter((x) => x.id !== targetId)
          : rule.targets.map((x) => (x.id === targetId ? { ...x, enabled: change === 'enable' } : x)),
      primaryTargetId: change === 'delete' && rule.primaryTargetId === targetId ? null : rule.primaryTargetId,
    };
    api.sync.upsert(repoId, next).then(refresh, reportError);
  };

  const targetMenu = (e: React.MouseEvent, m: BranchMapping, tg: PlannedTarget) => {
    const items: MenuItem[] = [
      {
        label: t('mapping.pushNow'),
        disabled: !tg.enabled || tg.remoteMissing || tg.direction === 'pull',
        onClick: () => openSyncPreview(repoId, [m.branch], [tg.targetId], 'push'),
      },
      {
        label: t('mapping.pullNow'),
        disabled: !tg.enabled || tg.remoteMissing || tg.direction === 'push',
        onClick: () => openSyncPreview(repoId, [m.branch], [tg.targetId], 'pull'),
      },
      { separator: true },
      tg.enabled
        ? { label: t('mapping.disable'), onClick: () => updateTarget(tg.ruleId, tg.targetId, 'disable') }
        : { label: t('mapping.enable'), onClick: () => updateTarget(tg.ruleId, tg.targetId, 'enable') },
      {
        label: t('common.delete'),
        danger: true,
        onClick: async () => {
          const ok = await ask({ title: t('mapping.deleteTargetTitle'), body: targetLabel(tg), danger: true, confirmLabel: t('common.delete') });
          if (ok) void updateTarget(tg.ruleId, tg.targetId, 'delete');
        },
      },
    ];
    menu.open(e, items);
  };

  const openRuleFor = (m: BranchMapping) => setDrawer({ rule: m.ruleId ? ruleById.get(m.ruleId) ?? null : null, branch: m.branch });

  return (
    <div className="mapping">
      <DeviationBanner mapping={mapping.data ?? []} unreachable={unreachable} onShow={() => setFilter('mismatch')} />
      <section className="panel">
        <div className="panel-header">
          <h3>Remotes</h3>
          <span className="spacer" />
          <button onClick={() => setRemoteDialog({ remote: null })}>+ {t('mapping.addRemote')}</button>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>{t('mapping.colName')}</th>
              <th>Fetch URL</th>
              <th>Push URL</th>
              <th>{t('mapping.colStatus')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(remotes.data ?? []).length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {t('mapping.noRemotes')}
                </td>
              </tr>
            )}
            {(remotes.data ?? []).map((r) => (
              <tr key={r.name}>
                <td className="mono">{r.name}</td>
                <td className="mono">{r.fetchUrl}</td>
                <td className="mono" title={r.pushUrls.join('\n')}>
                  {r.pushUrls.length === 0 ? <span className="muted">{t('mapping.sameAsFetch')}</span> : r.pushUrls.length === 1 ? r.pushUrls[0] : t('mapping.nUrls', { count: r.pushUrls.length })}
                </td>
                <td title={testErr[r.name]}>
                  {testing[r.name] === 'pending' ? (
                    <span className="muted">{t('mapping.testing')}</span>
                  ) : testing[r.name] === 'ok' ? (
                    <span className="ok-text inline-icon"><Icon name="dot" size={13} /> {t('mapping.reachable')}</span>
                  ) : testing[r.name] === 'fail' ? (
                    <span className="error-text inline-icon"><Icon name="dot" size={13} /> {t('mapping.unreachable')}</span>
                  ) : (
                    <span className="muted inline-icon"><Icon name="circle" size={13} /> {t('mapping.untested')}</span>
                  )}
                </td>
                <td className="row-actions">
                  <button className="small" onClick={() => setRemoteDialog({ remote: r })}>
                    {t('mapping.edit')}
                  </button>
                  <button className="small" onClick={() => testRemote(r.name)} disabled={testing[r.name] === 'pending'}>
                    {t('mapping.test')}
                  </button>
                  <button className="small danger" onClick={() => removeRemote(r)}>
                    {t('common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel grow">
        <div className="panel-header">
          <h3>{t('mapping.branchMapping')}</h3>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label={t('mapping.filter')}>
            {(['all', 'rules', 'noUpstream', 'diff', 'mismatch'] as const).map((f) => (
              <option key={f} value={f}>
                {t(`mapping.filter_${f}`)}
              </option>
            ))}
          </select>
          <input type="search" placeholder={t('common.search')} aria-label={t('common.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="spacer" />
          <button onClick={() => setDrawer({ rule: null })}>+ {t('mapping.addRule')}</button>
          <button
            className="primary"
            disabled={!(mapping.data ?? []).some((m) => m.ruleId)}
            onClick={() => openSyncPreview(repoId, null, null)}
          >
            <Icon name="sync" size={14} /> {t('mapping.syncAll')}
          </button>
        </div>
        {mapping.isError && <p className="error-text pad">{errorMessage(mapping.error)}</p>}
        <div className="scroll">
          <table className="grid mapping-table">
            <thead>
              <tr>
                <th>{t('mapping.colBranch')}</th>
                <th>Upstream</th>
                <th>{t('mapping.colTargets')}</th>
                <th>{t('mapping.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const rowSpan = Math.max(1, m.targets.length + (m.rulePattern && m.rulePattern !== m.branch ? 1 : 0));
                const first = (
                  <>
                    <td rowSpan={rowSpan} className="mono branch-cell">
                      {m.isHead && <Icon name="star" size={12} filled className="star" style={{ marginRight: 4 }} />}
                      {m.branch}
                      {m.ruleId && (
                        <button className="small link-btn" onClick={() => openRuleFor(m)}>
                          {t('mapping.edit')}
                        </button>
                      )}
                      {!m.ruleId && (
                        <button className="small link-btn" onClick={() => openRuleFor(m)}>
                          + {t('mapping.rule')}
                        </button>
                      )}
                    </td>
                    <td rowSpan={rowSpan} className="mono">
                      {m.upstream ?? <span className="muted">({t('common.none')})</span>}
                      {m.upstreamGone && <div className="warn-text inline-icon"><Icon name="warning" size={13} /> {t('branches.gone')}</div>}
                      {m.upstream && (m.ahead > 0 || m.behind > 0) && (
                        <div className="muted">
                          <AheadBehind ahead={m.ahead} behind={m.behind} />
                        </div>
                      )}
                      {m.upstreamState === 'mismatch' && (
                        <div className="mismatch">
                          <span className="warn-text inline-icon"><Icon name="warning" size={13} /> {t('mapping.mismatch')}</span>
                          <button className="small" onClick={() => resolveMismatch(m, 'git')}>
                            {t('mapping.preferGit')}
                          </button>
                          <button className="small" onClick={() => resolveMismatch(m, 'rule')}>
                            {t('mapping.preferRule')}
                          </button>
                        </div>
                      )}
                    </td>
                  </>
                );
                if (m.targets.length === 0) {
                  return (
                    <tr key={m.branch} onDoubleClick={() => openRuleFor(m)}>
                      {first}
                      <td className="muted">({t('common.none')})</td>
                      <td>{!m.upstream && <span className="warn-text inline-icon"><Icon name="warning" size={13} /> {t('mapping.untracked')}</span>}</td>
                    </tr>
                  );
                }
                const trs = [];
                const showTemplate = m.rulePattern && m.rulePattern !== m.branch;
                if (showTemplate) {
                  trs.push(
                    <tr key={`${m.branch}:rule`} onDoubleClick={() => openRuleFor(m)}>
                      {first}
                      <td className="muted" colSpan={2}>
                        {t('mapping.ruleTemplate', { pattern: m.rulePattern })}
                        {m.overriddenRuleIds.length > 0 && <span> · {t('mapping.overridden', { count: m.overriddenRuleIds.length })}</span>}
                      </td>
                    </tr>,
                  );
                }
                m.targets.forEach((tg, i) => {
                  trs.push(
                    <tr key={`${m.branch}:${tg.targetId}`} className={tg.enabled ? '' : 'disabled-row'} onDoubleClick={() => openRuleFor(m)} onContextMenu={(e) => targetMenu(e, m, tg)}>
                      {i === 0 && !showTemplate && first}
                      <td className="mono">
                        <Icon name={tg.direction === 'pull' ? 'arrowLeft' : tg.direction === 'both' ? 'swap' : 'arrowRight'} size={13} style={{ marginRight: 4 }} />
                        {targetLabel(tg)}
                        {tg.primary && <span className="tag">{t('mapping.primary')}</span>}
                        {tg.force && <span className="tag tag-warn">{t('mapping.force')}</span>}
                      </td>
                      <td>
                        <TargetStatus t={tg} />
                      </td>
                    </tr>,
                  );
                });
                return trs;
              })}
            </tbody>
          </table>
        </div>
      </section>

      {remoteDialog && <RemoteDialog repoId={repoId} remote={remoteDialog.remote} onClose={() => setRemoteDialog(null)} />}
      {drawer && <RuleDrawer repoId={repoId} rule={drawer.rule} branch={drawer.branch} onClose={() => setDrawer(null)} />}
      {menu.element}
    </div>
  );
}

/** 偏差检测汇总（M-07）：remote 不可达、规则引用的 remote 已删除、upstream 已删除、与规则不一致 */
function DeviationBanner({ mapping, unreachable, onShow }: { mapping: BranchMapping[]; unreachable: string[]; onShow: () => void }) {
  const { t } = useTranslation();
  const gone = mapping.filter((m) => m.upstreamGone).length;
  const missing = new Set(mapping.flatMap((m) => m.targets.filter((x) => x.remoteMissing).map((x) => x.remote ?? ''))).size;
  const mismatch = mapping.filter((m) => m.upstreamState === 'mismatch').length;
  const parts = [
    unreachable.length > 0 && t('deviation.unreachable', { names: unreachable.join(', ') }),
    missing > 0 && t('deviation.remoteMissing', { count: missing }),
    gone > 0 && t('deviation.upstreamGone', { count: gone }),
    mismatch > 0 && t('deviation.mismatch', { count: mismatch }),
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  return (
    <div className="banner banner-warn" role="status">
      <span className="inline-icon"><Icon name="warning" size={14} /> {parts.join(' · ')}</span>
      <button onClick={onShow}>{t('deviation.show')}</button>
    </div>
  );
}
