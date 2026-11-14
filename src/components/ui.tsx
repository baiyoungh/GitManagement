// 基础组件：对话框、确认框、提示、右键菜单、三态复选框
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useApp } from '../stores/appStore';
import type { CheckState } from '../lib/changeTree';
import { Icon } from './Icon';

const modalStack: { element: HTMLDivElement; priority: number }[] = [];
const topModal = () => [...modalStack].sort((a, b) => a.priority - b.priority).at(-1)?.element;
function syncModalStack() {
  const sorted = [...modalStack].sort((a, b) => a.priority - b.priority);
  sorted.forEach(({ element }, index) => {
    const top = index === sorted.length - 1;
    element.inert = !top;
    element.setAttribute('aria-modal', String(top));
    if (element.parentElement) element.parentElement.style.zIndex = String(1000 + index);
  });
}
const focusables = (element: HTMLElement) => Array.from(element.querySelectorAll<HTMLElement>(
  'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex="0"]',
));

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  priority?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useLayoutEffect(() => {
    const element = ref.current!;
    const prev = document.activeElement as HTMLElement | null;
    const entry = { element, priority: props.priority ?? 0 };
    modalStack.push(entry);
    syncModalStack();
    const focusFirst = () => (focusables(element).find((item) => !item.hasAttribute('data-close')) ?? element).focus();
    if (topModal() === element) focusFirst();
    const onKey = (e: KeyboardEvent) => {
      if (topModal() !== element) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      } else if (e.key === 'Tab') {
        const items = focusables(element);
        const first = items[0];
        const last = items.at(-1);
        if (!items.length) { e.preventDefault(); element.focus(); }
        else if (e.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
          e.preventDefault(); first?.focus();
        }
      }
    };
    const onFocus = (e: FocusEvent) => {
      if (topModal() === element && !element.contains(e.target as Node)) focusFirst();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      const wasTop = topModal() === element;
      modalStack.splice(modalStack.indexOf(entry), 1);
      syncModalStack();
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      if (wasTop) {
        const top = topModal();
        if (prev?.isConnected && (!top || top.contains(prev))) prev.focus();
        else (top && (focusables(top)[0] ?? top))?.focus();
      }
    };
  }, [props.priority]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && topModal() === ref.current && closeRef.current()}>
      <div className="modal" role="dialog" aria-label={typeof props.title === 'string' ? props.title : undefined} aria-modal="true" tabIndex={-1} ref={ref} style={{ width: props.width ?? 520 }}>
        <div className="modal-header">
          <h2>{props.title}</h2>
          <button className="icon-btn" data-close onClick={props.onClose} aria-label="close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-footer">{props.footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** 全局确认框（危险操作确认规则，specs/02 第 10 节） */
export function ConfirmHost() {
  const { t } = useTranslation();
  const confirm = useApp((s) => s.confirm);
  const resolve = useApp((s) => s.resolveConfirm);
  if (!confirm) return null;
  return (
    <Modal
      title={confirm.title}
      onClose={() => resolve('cancel')}
      width={480}
      footer={
        <>
          <button onClick={() => resolve('cancel')}>{t('common.cancel')}</button>
          {confirm.altLabel && (
            <button className={confirm.altDanger ? 'danger' : undefined} onClick={() => resolve('alt')}>
              {confirm.altLabel}
            </button>
          )}
          <button className={confirm.danger ? 'danger' : 'primary'} onClick={() => resolve('confirm')}>
            {confirm.confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <p className="pre-line">{confirm.body}</p>
      {confirm.items && confirm.items.length > 0 && (
        <ul className="confirm-items">
          {confirm.items.slice(0, 50).map((i) => (
            <li key={i} className="mono">
              {i}
            </li>
          ))}
          {confirm.items.length > 50 && <li>… +{confirm.items.length - 50}</li>}
        </ul>
      )}
      {confirm.note && <p className="muted">{confirm.note}</p>}
    </Modal>
  );
}

/** 输入框对话框（替代 window.prompt） */
export function PromptHost() {
  const { t } = useTranslation();
  const req = useApp((s) => s.promptReq);
  const resolve = useApp((s) => s.resolvePrompt);
  const [value, setValue] = useState('');
  useEffect(() => setValue(req?.initial ?? ''), [req]);
  if (!req) return null;
  const err = value.trim() ? req.validate?.(value.trim()) ?? null : null;
  const ok = value.trim().length > 0 && !err;
  return (
    <Modal
      title={req.title}
      onClose={() => resolve(null)}
      width={440}
      footer={
        <>
          <button onClick={() => resolve(null)}>{t('common.cancel')}</button>
          <button className="primary" disabled={!ok} onClick={() => resolve(value.trim())}>
            {req.confirmLabel ?? t('common.ok')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) resolve(value.trim());
        }}
      >
        <Field label={req.label ?? req.title} hint={err ? <span className="error-text">{err}</span> : undefined}>
          <input value={value} placeholder={req.placeholder} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

export function Toasts() {
  const { t } = useTranslation();
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast toast-${x.kind}`}>
          <div className="toast-row">
            <span>{x.message}</span>
            <button className="icon-btn" onClick={() => dismiss(x.id)} aria-label={t('common.close')}>
              <Icon name="close" />
            </button>
          </div>
          {x.detail && (
            <details>
              <summary>{t('common.details')}</summary>
              <pre>{x.detail}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  separator?: boolean;
}

export function ContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(props.x, window.innerWidth - r.width - 4),
      y: Math.min(props.y, window.innerHeight - r.height - 4),
    });
    el.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  }, [props.x, props.y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        btns[next]?.focus();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', props.onClose);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', props.onClose);
      window.removeEventListener('keydown', onKey);
    };
  }, [props]);
  return createPortal(
    <div className="context-menu" ref={ref} role="menu" style={{ left: pos.x, top: pos.y }}>
      {props.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            className={it.danger ? 'menu-danger' : undefined}
            onClick={() => {
              props.onClose();
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: { clientX: number; clientY: number; preventDefault: () => void; currentTarget?: EventTarget | null }, items: MenuItem[]) => {
    e.preventDefault();
    // WebKit may select a word on secondary click. Clear only selections in
    // the clicked control, never text selected in an editor or input.
    const target = e.currentTarget;
    const selection = window.getSelection();
    if (target instanceof HTMLElement && target.matches('button, h3, [role="tree"]')
      && selection?.anchorNode && target.contains(selection.anchorNode)) selection.removeAllRanges();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const element = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, element };
}

export function TriCheckbox(props: { state: CheckState; onChange: () => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.state === 'partial';
  }, [props.state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={props.label}
      aria-checked={props.state === 'partial' ? 'mixed' : props.state === 'checked'}
      checked={props.state === 'checked'}
      disabled={props.disabled}
      onChange={props.onChange}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (!ahead && !behind) return null;
  return (
    <span className="ab">
      {ahead > 0 && <span className="inline-icon" title={`ahead ${ahead}`}><Icon name="arrowUp" size={12} />{ahead}</span>}
      {behind > 0 && <span className="inline-icon" title={`behind ${behind}`}><Icon name="arrowDown" size={12} />{behind}</span>}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
