// 分支弹窗（⌘⇧` / Ctrl+Shift+`，specs/06 第 4 节）与切换仓库（⌘P / Ctrl+P）
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import type { BranchInfo } from '../api/types';
import { invalidateRepo, reportError, useBranches, useRepos } from '../api/queries';
import { useApp } from '../stores/appStore';
import { AheadBehind, Modal } from '../components/ui';
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
  const toast = useApp((s) => s.toast);
  const list = branches.data ?? [];
  const checkout = async (b: BranchInfo) => {
    if (b.kind === 'local') await checkoutBranch(repoId, b.name);
    else if (b.remote && b.remoteBranch) {
      const local = list.find((x) => x.kind === 'local' && x.name === b.remoteBranch);
      if (local) await checkoutBranch(repoId, local.name);
      else
        await api.branch
          .checkoutRemote(repoId, b.remote, b.remoteBranch)
          .then((name) => toast('success', t('branches.checkedOut', { name })), reportError);
    }
    invalidateRepo(repoId);
  };
  const items: Item[] = [
    {
      key: '+new',
      section: t('branchPopup.actions'),
      label: <span className="inline-icon"><Icon name="plus" size={14} /> {t('branches.newBranch')}…</span>,
      text: t('branches.newBranch'),
      run: () => {
        setTimeout(() => openDialog({ type: 'createBranch', repoId }), 0);
      },
    },
    {
      key: '+rev',
      section: t('branchPopup.actions'),
      label: <span className="inline-icon"><Icon name="swap" size={14} /> {t('branchPopup.checkoutRev')}…</span>,
      text: t('branchPopup.checkoutRev'),
      run: async () => {
        const rev = await prompt({ title: t('branchPopup.checkoutRev'), label: t('diff.compareRevLabel'), placeholder: 'v1.0 / a1b2c3d' });
        if (rev) await checkoutBranch(repoId, rev);
        invalidateRepo(repoId);
      },
    },
    ...list
      .filter((b) => b.kind === 'local')
      .sort((a, b) => Number(b.isHead) - Number(a.isHead) || b.committerTime - a.committerTime)
      .map((b) => ({
        key: b.fullRef,
        section: t('branches.local'),
        text: b.name,
        label: (
          <>
            <span>
              {b.isHead && <Icon name="star" size={12} filled className="star" style={{ marginRight: 4 }} />}
              {b.name}
            </span>
            <AheadBehind ahead={b.ahead} behind={b.behind} />
          </>
        ),
        run: () => checkout(b),
      })),
    ...list
      .filter((b) => b.kind === 'remote')
      .map((b) => ({ key: b.fullRef, section: t('branches.remote'), text: b.name, label: <span>{b.name}</span>, run: () => checkout(b) })),
  ];
  return <Picker title={t('branchPopup.title')} placeholder={t('branches.search')} items={items} />;
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
