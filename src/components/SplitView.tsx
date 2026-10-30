import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fitPanelSizes, minimumPercentages, normalizeSizes, resizePanelPair } from '../lib/panelSizes';

interface Props {
  id: string;
  children: ReactNode;
  direction?: 'row' | 'column';
  initialSizes?: number[];
  minSizes?: number[];
  className?: string;
  collapsed?: { index: number; size: number };
}

export function SplitView({ id, children, direction = 'row', initialSizes = [], minSizes = [], className = '', collapsed }: Props) {
  const { t } = useTranslation();
  const panes = Children.toArray(children).filter(isValidElement);
  const count = panes.length;
  const key = `gitmanagement.layout.${id}`;
  const defaults = normalizeSizes(initialSizes, count);
  const [preferred, setPreferred] = useState<number[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      return Array.isArray(saved) && saved.length === count && saved.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
        ? normalizeSizes(saved, count) : defaults;
    } catch { return defaults; }
  });
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; start: number; sizes: number[]; latest: number[]; available: number } | null>(null);
  const [length, setLength] = useState(0);
  const [dragging, setDragging] = useState(false);
  const minimums = panes.map((_, i) => minSizes[i] ?? (direction === 'row' ? 140 : 70));
  const available = Math.max(0, length - (count - 1) * 6);
  const sizes = fitPanelSizes(preferred, minimums, available);
  const mins = minimumPercentages(minimums, available);
  const coordinate = (e: { clientX: number; clientY: number }) => direction === 'row' ? e.clientX : e.clientY;
  const save = (values: number[]) => {
    setPreferred(values);
    try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* Layout remains usable without storage. */ }
  };
  const finish = () => {
    if (!drag.current) return;
    save(drag.current.latest);
    drag.current = null;
    setDragging(false);
  };

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setLength(direction === 'row' ? el.clientWidth : el.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [direction]);

  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset.resizing = direction;
    return () => { delete document.documentElement.dataset.resizing; };
  }, [dragging, direction]);

  return (
    <div ref={root} className={`split-view split-${direction} ${className}`} data-split={id}>
      {panes.map((pane, i) => (
        <Fragment key={pane.key ?? i}>
          <div className="split-pane" id={`${id}-pane-${i}`} style={{ flex: collapsed?.index === i ? `0 0 ${collapsed.size}px` : `${sizes[i]} 1 0px` }}>
            {pane}
          </div>
          {i < count - 1 && !collapsed && (
            <div
              className={`split-handle ${dragging && drag.current?.index === i ? 'dragging' : ''}`}
              role="separator"
              tabIndex={0}
              aria-label={t('layout.resize')}
              aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
              aria-controls={`${id}-pane-${i}`}
              aria-valuemin={Math.round(mins[i] ?? 0)}
              aria-valuemax={Math.round(sizes[i] + sizes[i + 1] - (mins[i + 1] ?? 0))}
              aria-valuenow={Math.round(sizes[i])}
              title={t('layout.resize')}
              onPointerDown={(e) => {
                if (e.button !== 0 || drag.current) return;
                e.preventDefault();
                e.currentTarget.focus();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { index: i, start: coordinate(e), sizes, latest: sizes, available };
                setDragging(true);
              }}
              onPointerMove={(e) => {
                const d = drag.current;
                if (!d || d.index !== i) return;
                d.latest = resizePanelPair(d.sizes, i, coordinate(e) - d.start, minimums, d.available);
                setPreferred(d.latest);
              }}
              onPointerUp={finish}
              onPointerCancel={finish}
              onLostPointerCapture={finish}
              onDoubleClick={() => save(defaults)}
              onKeyDown={(e) => {
                const backward = direction === 'row' ? 'ArrowLeft' : 'ArrowUp';
                const forward = direction === 'row' ? 'ArrowRight' : 'ArrowDown';
                if (![backward, forward, 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const delta = e.key === 'Home' ? -available : e.key === 'End' ? available : (e.key === backward ? -1 : 1) * (e.shiftKey ? 40 : 10);
                save(resizePanelPair(sizes, i, delta, minimums, available));
              }}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
