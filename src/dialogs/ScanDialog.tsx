// 扫描目录导入（R-03）：选择父目录，按深度递归发现仓库，勾选后批量导入，可选放入分组
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { ScanItem } from '../api/types';
import { keys, queryClient, reportError, useGroups } from '../api/queries';
import { useApp } from '../stores/appStore';
import { Field, Modal } from '../components/ui';
import { shortPath } from '../lib/format';
import { errorMessage } from '../lib/errors';
import { parentRepo } from '../lib/repoPaths';

export function ScanDialog({ initialRoot = '', initialGroup = '' }: { initialRoot?: string; initialGroup?: string | null }) {
  const { t } = useTranslation();
  const close = useApp((s) => s.closeDialog);
  const toast = useApp((s) => s.toast);
  const groups = useGroups();
  const [root, setRoot] = useState(initialRoot);
  const [depth, setDepth] = useState(3);
  const [items, setItems] = useState<ScanItem[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<string>(initialGroup ?? '');
  const [busy, setBusy] = useState(false);
  const resetResults = () => { setItems(null); setPicked(new Set()); setTruncated(false); };

  const browse = async () => {
    const r = await open({ directory: true, multiple: false });
    if (typeof r === 'string') { setRoot(r); resetResults(); }
  };

  const scan = async () => {
    setBusy(true);
    try {
      const r = await api.scan.run(root.trim(), depth);
      setItems(r.repos);
      setTruncated(r.truncated);
      setPicked(new Set(r.repos.filter((x) => !x.registered).map((x) => x.path)));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const importNow = async () => {
    setBusy(true);
    try {
      let gid: string | null = group || null;
      if (group === '__new') {
        const name = root.trim().split(/[\\/]/).filter(Boolean).pop() ?? 'Imported';
        gid = (await api.group.create(name)).id;
      }
      const r = await api.scan.addMany([...picked], gid);
      await queryClient.invalidateQueries({ queryKey: keys.repos });
      await queryClient.invalidateQueries({ queryKey: keys.groups });
      if (r.failed.length)
        toast('error', t('scan.someFailed', { count: r.failed.length }), r.failed.map(([p, e]) => `${p}: ${errorMessage(e)}`).join('\n'));
      toast('success', t('scan.imported', { count: r.added.length }));
      close();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const selectable = (items ?? []).filter((x) => !x.registered);
  const allOn = selectable.length > 0 && selectable.every((x) => picked.has(x.path));

  return (
    <Modal
      title={t(initialRoot ? 'sidebar.scanChildren' : 'scan.title')}
      onClose={close}
      width={680}
      footer={
        <>
          <button onClick={close}>{t('common.cancel')}</button>
          <button className="primary" disabled={busy || picked.size === 0} onClick={() => void importNow()}>
            {t('scan.import', { count: picked.size })}
          </button>
        </>
      }
    >
      <div className="row-fields">
        <Field label={t('scan.root')}>
          <div className="input-row">
            <input disabled={busy} value={root} onChange={(e) => { setRoot(e.target.value); resetResults(); }} placeholder="~/work" />
            <button disabled={busy} onClick={() => void browse()}>{t('common.browse')}</button>
          </div>
        </Field>
        <Field label={t('scan.depth')}>
          <input disabled={busy} type="number" min={1} max={8} value={depth} onChange={(e) => { setDepth(Math.max(1, Math.min(8, Number(e.target.value) || 1))); resetResults(); }} />
        </Field>
      </div>
      <div className="action-row">
        <button disabled={!root.trim() || busy} onClick={() => void scan()}>
          {busy && !items ? t('scan.scanning') : t('scan.scan')}
        </button>
        <span className="muted small-text">{t('scan.skipHint')}</span>
      </div>
      {items && (
        <>
          <div className="scan-head">
            <label className="check">
              <input type="checkbox" checked={allOn} disabled={selectable.length === 0} onChange={() => setPicked(allOn ? new Set() : new Set(selectable.map((x) => x.path)))} />
              {t('scan.found', { count: items.length })}
            </label>
            {truncated && <span className="warn-text small-text">{t('scan.truncated')}</span>}
          </div>
          <ul className="scan-list">
            {items.map((x) => (
              <li key={x.path}>
                <label className="check">
                  <input
                    type="checkbox"
                    disabled={x.registered}
                    checked={x.registered || picked.has(x.path)}
                    onChange={() => {
                      const n = new Set(picked);
                      if (n.has(x.path)) n.delete(x.path);
                      else n.add(x.path);
                      setPicked(n);
                    }}
                  />
                  <strong>{x.name}</strong>
                  {parentRepo(x.path, items) && <span className="tag" title={parentRepo(x.path, items)?.path}>{t('scan.nested')}</span>}
                  <span className="mono muted">{shortPath(x.path)}</span>
                  {x.registered && <span className="tag">{t('scan.registered')}</span>}
                  {x.linked && <span className="tag">{t('scan.linked')}</span>}
                </label>
              </li>
            ))}
          </ul>
          <Field label={t('scan.group')}>
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t('groups.ungrouped')}</option>
              <option value="__new">{t('scan.newGroup')}</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </Modal>
  );
}
