import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../i18n';
import { SplitView } from './SplitView';

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1006);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(506);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function panes(extra = {}) {
  return <SplitView id="test" initialSizes={[30, 70]} minSizes={[100, 100]} {...extra}><div>left</div><div>right</div></SplitView>;
}

describe('SplitView', () => {
  it('persists keyboard resizing, restores on remount and resets on double click', () => {
    const view = render(panes());
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('31');
    view.unmount();
    render(panes());
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('31');
    fireEvent.doubleClick(screen.getByRole('separator'));
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('30');
  });

  it('clamps keyboard moves at the minimum sizes', () => {
    render(panes());
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('10');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'End' });
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('90');
  });

  it('fixes a collapsed panel without overwriting the saved expanded layout', () => {
    localStorage.setItem('gitmanagement.layout.test', '[40,60]');
    const view = render(panes({ collapsed: { index: 1, size: 34 } }));
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByText('right').parentElement?.style.flexBasis).toBe('34px');
    view.rerender(panes());
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('40');
  });

  it('ignores corrupt local storage', () => {
    localStorage.setItem('gitmanagement.layout.test', '{broken');
    render(panes());
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('30');
  });
});
