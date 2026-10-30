import { expect, it } from 'vitest';
import { terminalInputChunks } from './terminalInput';

it('preserves non-BMP characters across terminal IPC boundaries', () => {
  const input = `${'x'.repeat(16383)}\u{1f680}${'中'.repeat(20000)}`;
  const chunks = terminalInputChunks(input);
  expect(chunks.join('')).toBe(input);
  for (const chunk of chunks) {
    expect(new TextDecoder().decode(new TextEncoder().encode(chunk))).toBe(chunk);
    expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(64 * 1024);
  }
});
