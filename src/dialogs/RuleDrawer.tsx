// 规则编辑抽屉（specs/03 第 4.3 节；M-04）
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { SyncDirection, SyncRule, SyncTarget } from '../api/types';
import { invalidateRepo, reportError, useBranches, useRemotes } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field } from '../components/ui';
import { Icon } from '../components/Icon';
import { expandBranch, isWildcard, matchingRules, ruleMatches } from '../lib/ruleMatch';
import { useRules } from '../views/MappingView';
import { openSyncPreview } from './SyncDialog';

let tmpId = 0;
const newTargetId = () => `new-${++tmpId}`;

export function RuleDrawer({ repoId, rule, branch, onClose }: { repoId: string; rule: SyncRule | null; branch?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const remotes = useRemotes(repoId);
  const branches = useBranches(repoId);
  const rules = useRules(repoId);
  const ask = useApp((s) => s.ask);
  const toast = useApp((s) => s.toast);
  const firstRemote = remotes.data?.[0]?.name ?? null;

  const [pattern, setPattern] = useState(rule?.branchPattern ?? branch ?? '');
  const [order, setOrder] = useState(rule?.order ?? 10);
  const [targets, setTargets] = useState<SyncTarget[]>(
    () =>
      rule?.targets ?? [
        { id: newTargetId(), remote: firstRemote, url: null, remoteBranch: '${branch}', direction: 'both', force: false, enabled: true },
      ],
  );
  const [primary, setPrimary] = useState<string | null>(rule?.primaryTargetId ?? targets[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  const locals = (branches.data ?? []).filter((b) => b.kind === 'local').map((b) => b.name);
  const matched = useMemo(() => locals.filter((b) => pattern.trim() && ruleMatches({ branchPattern: pattern.trim() }, b)), [locals, pattern]);
  // 被更高优先级规则覆盖的分支（specs/03 第 7 节）
  const shadowed = useMemo(() => {
    const others = (rules.data ?? []).filter((r) => r.id !== rule?.id);
    const self = { id: rule?.id ?? '__self', branchPattern: pattern.trim(), order };
    return matched
      .map((b) => ({ b, winner: matchingRules([...others, self], b)[0] }))
      .filter((x) => x.winner && x.winner.id !== self.id)
      .map((x) => ({ branch: x.b, pattern: x.winner.branchPattern }));
  }, [rules.data, rule?.id, pattern, order, matched]);

  const update = (id: string, patch: Partial<SyncTarget>) => setTargets((ts) => ts.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const remoteNames = (remotes.data ?? []).map((r) => r.name);

  const valid = pattern.trim().length > 0 && targets.length > 0 && targets.every((x) => (x.remote || x.url?.trim()) && x.remoteBranch.trim());

  const save = async (andSync: boolean) => {
    setBusy(true);
    try {
      // 新目标的临时 id 交给后端重新生成；primary 按位置映射回新 id
      const primaryIndex = targets.findIndex((x) => x.id === primary);
      const payload: SyncRule = {
        id: rule?.id ?? '',
        repoId,
        branchPattern: pattern.trim(),
        order,
        targets: targets.map((x) => ({ ...x, id: x.id.startsWith('new-') ? '' : x.id, url: x.remote ? null : x.url?.trim() || null })),
        primaryTargetId: null,
      };
      // 先保存获得 id，再设置 primary（primary 写 upstream）
      let saved = (await api.sync.upsert(repoId, payload)).rule;
      if (primaryIndex >= 0 && saved.targets[primaryIndex]) {
        const res = await api.sync.upsert(repoId, { ...saved, primaryTargetId: saved.targets[primaryIndex].id });
        saved = res.rule;
        if (res.upstreamUpdated.length) toast('info', t('mapping.upstreamUpdated', { branches: res.upstreamUpdated.join(', ') }));
      }
      invalidateRepo(repoId);
      onClose();
      if (andSync) openSyncPreview(repoId, matched, null);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!rule) return;
    const ok = await ask({ title: t('mapping.deleteRuleTitle'), body: t('mapping.deleteRuleBody', { pattern: rule.branchPattern }), danger: true, confirmLabel: t('common.delete') });
    if (!ok) return;
    api.sync.delete(rule.id).then(() => {
      invalidateRepo(repoId);
      onClose();
    }, reportError);
  };

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={t('mapping.editRule')}>
        <div className="modal-header">
          <h2>{rule ? t('mapping.editRule') : t('mapping.addRule')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">
          <div className="field-row">
            <Field label={t('mapping.pattern')} hint={isWildcard(pattern) ? t('mapping.wildcardHint') : t('mapping.exactHint')}>
              <input value={pattern} onChange={(e) => setPattern(e.target.value)} className="mono" placeholder="main / feature/*" list="rule-branches" autoFocus />
              <datalist id="rule-branches">
                {locals.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Field>
            <Field label={t('mapping.order')} hint={t('mapping.orderHint')}>
              <input type="number" value={order} onChange={(e) => setOrder(Number(e.target.value) || 0)} style={{ width: 80 }} />
            </Field>
          </div>

          <h4>{t('mapping.targets')}</h4>
          <div className="targets">
            {targets.map((x) => (
              <div className="target-card" key={x.id}>
                <div className="input-row">
                  <label className="check" title={t('mapping.primaryHint')}>
                    <input type="radio" name="primary" checked={primary === x.id} onChange={() => setPrimary(x.id)} disabled={!x.remote} />
                    {t('mapping.primary')}
                  </label>
                  <select
                    value={x.remote ?? '__url'}
                    onChange={(e) => update(x.id, e.target.value === '__url' ? { remote: null, url: x.url ?? '' } : { remote: e.target.value, url: null })}
                    aria-label="Remote"
                  >
                    {remoteNames.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                    {x.remote && !remoteNames.includes(x.remote) && <option value={x.remote}>⚠ {x.remote}</option>}
                    <option value="__url">URL…</option>
                  </select>
                  {!x.remote && (
                    <input className="mono grow-input" value={x.url ?? ''} onChange={(e) => update(x.id, { url: e.target.value })} placeholder="https://…/repo.git" aria-label="URL" />
                  )}
                  <input className="mono" value={x.remoteBranch} onChange={(e) => update(x.id, { remoteBranch: e.target.value })} aria-label={t('branchDialog.remoteBranch')} />
                  <button
                    className="icon-btn"
                    aria-label={t('common.delete')}
                    onClick={() => {
                      setTargets(targets.filter((y) => y.id !== x.id));
                      if (primary === x.id) setPrimary(null);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <div className="input-row">
                  <select value={x.direction} onChange={(e) => update(x.id, { direction: e.target.value as SyncDirection })} aria-label={t('mapping.direction')}>
                    <option value="both">{t('mapping.dirBoth')}</option>
                    <option value="push">{t('mapping.dirPush')}</option>
                    <option value="pull">{t('mapping.dirPull')}</option>
                  </select>
                  <label className="check">
                    <input type="checkbox" checked={x.force} disabled={x.direction === 'pull'} onChange={(e) => update(x.id, { force: e.target.checked })} />
                    {t('mapping.force')}
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={x.enabled} onChange={(e) => update(x.id, { enabled: e.target.checked })} />
                    {t('mapping.enabled')}
                  </label>
                  {x.remote && !remoteNames.includes(x.remote) && <span className="error-text">{t('mapping.remoteMissing')}</span>}
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => {
              const id = newTargetId();
              setTargets([...targets, { id, remote: firstRemote, url: firstRemote ? null : '', remoteBranch: '${branch}', direction: 'push', force: false, enabled: true }]);
            }}
          >
            + {t('mapping.addTarget')}
          </button>

          <h4>{t('mapping.preview', { count: matched.length })}</h4>
          <ul className="preview-list mono">
            {matched.slice(0, 20).map((b) => (
              <li key={b}>
                {b} → {targets.filter((x) => x.enabled).map((x) => `${x.remote ?? 'URL'}/${expandBranch(x.remoteBranch, b)}`).join(', ') || '-'}
              </li>
            ))}
            {matched.length > 20 && <li>… +{matched.length - 20}</li>}
          </ul>
          {shadowed.length > 0 && (
            <div className="warn-box">
              <div>
                <p>{t('mapping.shadowed')}</p>
                <ul className="mono">
                  {shadowed.map((s) => (
                    <li key={s.branch}>
                      {s.branch} ← {s.pattern}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {rule && (
            <button className="danger" onClick={remove}>
              {t('common.delete')}
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>{t('common.cancel')}</button>
          <button disabled={!valid || busy} onClick={() => save(false)}>
            {t('common.save')}
          </button>
          <button className="primary" disabled={!valid || busy || matched.length === 0} onClick={() => save(true)}>
            {t('mapping.saveAndSync')}
          </button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
