import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Modal } from './ui';
afterEach(cleanup);
it('only the top modal handles Escape and restores focus to its parent', () => {
  const parentClose = vi.fn();
  const topClose = vi.fn();
  const view = render(<><Modal title="Settings" onClose={parentClose}><input aria-label="Parent" /></Modal><Modal title="Auth" priority={100} onClose={topClose}><input aria-label="Secret" /></Modal></>);
  expect(document.activeElement).toBe(screen.getByLabelText('Secret'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(topClose).toHaveBeenCalledTimes(1);
  expect(parentClose).not.toHaveBeenCalled();
  view.rerender(<Modal title="Settings" onClose={parentClose}><input aria-label="Parent" /></Modal>);
  expect(document.activeElement).toBe(screen.getByLabelText('Parent'));
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(parentClose).toHaveBeenCalledTimes(1);
});
it('traps Tab and keeps high-priority auth above newly mounted normal dialogs', () => {
  render(<><Modal title="Auth" priority={100} onClose={() => {}}><input aria-label="Secret" /><button>Continue</button></Modal><Modal title="Other" onClose={() => {}}><input aria-label="Other input" /></Modal></>);
  const input = screen.getByLabelText('Secret');
  expect(document.activeElement).toBe(input);
  screen.getByRole('button', { name: 'Continue' }).focus();
  fireEvent.keyDown(window, { key: 'Tab' });
  expect(document.activeElement?.getAttribute('data-close')).not.toBeNull();
  fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }));
});
