// 分支弹窗（⌘⇧` / Ctrl+Shift+`，specs/06 第 4 节）与切换仓库（⌘P / Ctrl+P）
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidateRepo, useBranches, useRepos } from '../api/queries';
import { useApp } from '../stores/appStore';
import { AheadBehind, Modal } from '../components/ui';
import { useBranchActions } from '../hooks/useBranchActions';
import { Icon } from '../components/Icon';
import { checkoutBranch } from '../lib/actions';
import { shortPath } from '../lib/format';

interface Item {
  key: string;
  section: string;
  label: ReactNode;
  text: string;
  run: () => void | Promise<unknown>;
}

function Picker({ title, placeholder, items }: { title: string; placeholder: string; items: Item[] }) {
  const close = useApp((s) => s.closeDialog);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    // 简单的子序列模糊匹配：fb → feature/bar
    const fuzzy = (text: string) => {
      let i = 0;
      for (const c of text.toLowerCase()) if (c === s[i]) i++;
      return i === s.length;
    };
    return items.filter((x) => x.text.toLowerCase().includes(s) || fuzzy(x.text));
  }, [items, q]);
  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    void it.run();
  };
  return (
    <Modal title={title} onClose={close} width={480}>
      <input
        className="picker-input"
        value={q}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
            setActive(n);
            listRef.current?.children[n]?.scrollIntoView({ block: 'nearest' });
          } else if (e.key === 'Enter') {
            e.preventDefault();
            run(shown[active]);
          }
        }}
      />
      <ul className="picker-list" role="listbox" ref={listRef}>
        {shown.map((it, i) => (
          <li key={it.key} role="option" aria-selected={i === active}>
            {(i === 0 || shown[i - 1].section !== it.section) && <div className="picker-section">{it.section}</div>}
            <button className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onClick={() => run(it)}>
              {it.label}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function BranchPopup({ repoId }: { repoId: string }) {
  const { t } = useTranslation();
  const branches = useBranches(repoId);
  const openDialog = useApp((s) => s.openDialog);
  const prompt = useApp((s) => s.prompt);
  const close = useApp((s) => s.closeDialog);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const list = branches.data ?? [];
  const { actionsFor, checkout } = useBranchActions(repoId, list);
  const filtered = list.filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = [
    { key: 'local', label: t('branches.local'), branches: filtered.filter((b) => b.kind === 'local').sort((a, b) => Number(b.isHead) - Number(a.isHead) || a.name.localeCompare(b.name)) },
    ...[...new Set(filtered.filter((b) => b.kind === 'remote').map((b) => b.remote ?? ''))].sort().map((remote) => ({
      key: `remote:${remote}`, label: `${t('branches.remote')} / ${remote}`,
      branches: filtered.filter((b) => b.kind === 'remote' && (b.remote ?? '') === remote).sort((a, b) => a.name.localeCompare(b.name)),
    })),
  ];
  const shown = groups.flatMap((g) => collapsed.has(g.key) && !query ? [] : g.branches);
  const active = shown.find((b) => b.fullRef === selected) ?? shown.find((b) => b.isHead) ?? shown[0];
  const focusAction = () => actionsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  const selectNext = (delta: number) => {
    const index = shown.findIndex((b) => b.fullRef === active?.fullRef);
    const next = shown[Math.max(0, Math.min(shown.length - 1, index + delta))];
    if (next) {
      setSelected(next.fullRef);
      Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-branch-ref]') ?? [])
        .find((el) => el.dataset.branchRef === next.fullRef)?.scrollIntoView({ block: 'nearest' });
    }
  };
  return (
    <Modal title={t('branchPopup.title')} onClose={close} width={860}>
      <div className="branch-popup-tools">
        <button onClick={() => openDialog({ type: 'createBranch', repoId })}><Icon name="plus" size={14} />{t('branches.newBranch')}</button>
        <button onClick={async () => {
          close();
          const rev = await prompt({ title: t('branchPopup.checkoutRev'), label: t('diff.compareRevLabel'), placeholder: 'v1.0 / a1b2c3d' });
          if (rev) await checkoutBranch(repoId, rev);
          invalidateRepo(repoId);
        }}><Icon name="swap" size={14} />{t('branchPopup.checkoutRev')}</button>
      </div>
      <div className="branch-popup">
        <div className="branch-popup-list" ref={listRef} onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); selectNext(e.key === 'ArrowDown' ? 1 : -1); }
          if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); focusAction(); }
        }}>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('branches.search')} aria-label={t('branches.search')} />
          {branches.isLoading && <p className="muted pad">{t('common.loading')}</p>}
          {branches.isError && <p className="error-text pad">{t('branchPopup.loadFailed')}</p>}
          {!branches.isLoading && !branches.isError && filtered.length === 0 && <p className="muted pad">{t('branchPopup.empty')}</p>}
          {groups.filter((g) => g.branches.length > 0).map((g) => (
            <section key={g.key}>
              <button className="branch-folder" aria-expanded={!!query || !collapsed.has(g.key)} onClick={() => setCollapsed((prev) => {
                const next = new Set(prev); if (next.has(g.key)) next.delete(g.key); else next.add(g.key); return next;
              })}>
                <Icon name={!query && collapsed.has(g.key) ? 'chevronRight' : 'chevronDown'} size={14} />
                {g.key.startsWith('remote:') && <Icon name="folder" size={14} />}{g.label}
              </button>
              {(!!query || !collapsed.has(g.key)) && g.branches.map((b) => (
                <button key={b.fullRef} data-branch-ref={b.fullRef} className={`branch-popup-row ${active?.fullRef === b.fullRef ? 'selected' : ''}`}
                  aria-expanded={active?.fullRef === b.fullRef} aria-controls="branch-popup-actions" aria-current={b.isHead ? 'true' : undefined}
                  onClick={() => setSelected(b.fullRef)} onDoubleClick={() => { if (!b.isHead) { close(); void checkout(b); } }}
                  onContextMenu={(e) => { e.preventDefault(); setSelected(b.fullRef); focusAction(); }}>
                  <Icon name={b.isHead ? 'star' : 'branch'} filled={b.isHead} className={b.isHead ? 'star' : ''} size={15} />
                  <span className="branch-name" title={b.name}>{b.kind === 'remote' ? b.remoteBranch ?? b.name : b.name}</span>
                  {b.upstream && <span className="branch-popup-upstream" title={b.upstream}>{b.upstream}</span>}
                  <AheadBehind ahead={b.ahead} behind={b.behind} /><Icon name="chevronRight" size={14} />
                </button>
              ))}
            </section>
          ))}
        </div>
        <div id="branch-popup-actions" className="branch-popup-actions" ref={actionsRef} role="menu" aria-label={active?.name ?? t('branchPopup.actions')}
          onKeyDown={(e) => {
            const buttons = Array.from(actionsRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
            if (e.key === 'ArrowLeft') { e.preventDefault(); listRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault(); const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }
          }}>
          {active && <>
            <div className="branch-popup-selection"><Icon name="branch" size={15} /><strong title={active.name}>{active.name}</strong><span className="mono muted">{active.oid.slice(0, 8)}</span></div>
            {actionsFor(active).map((action, i) => action.separator ? <div className="menu-sep" role="separator" key={i} /> : (
              <button role="menuitem" key={i} disabled={action.disabled} className={action.danger ? 'menu-danger' : ''} onClick={() => { close(); action.onClick?.(); }}>{action.label}</button>
            ))}
          </>}
        </div>
      </div>
    </Modal>
  );
}

export function RepoSwitcher() {
  const { t } = useTranslation();
  const repos = useRepos();
  const selectRepo = useApp((s) => s.selectRepo);
  const favSection = `★ ${t('sidebar.favorites')}`;
  const items: Item[] = (repos.data ?? []).map((r) => ({
    key: r.id,
    section: r.favorite ? favSection : t('sidebar.repositories'),
    text: `${r.name} ${r.path}`,
    label: (
      <>
        <strong>{r.name}</strong>
        <span className="muted mono small-text">{shortPath(r.path)}</span>
      </>
    ),
    run: () => selectRepo(r.id),
  }));
  items.sort((a, b) => Number(b.section === favSection) - Number(a.section === favSection));
  return <Picker title={t('repoSwitcher.title')} placeholder={t('sidebar.search')} items={items} />;
}
