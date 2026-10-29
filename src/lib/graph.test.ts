import { describe, expect, it } from 'vitest';
import type { LogCommit } from '../api/types';
import { layoutGraph } from './graph';

const c = (hash: string, parents: string[]): LogCommit => ({
  hash,
  shortHash: hash,
  parents,
  authorName: '',
  authorEmail: '',
  authorTime: 0,
  subject: hash,
  refs: [],
});

describe('layoutGraph', () => {
  it('linear history stays in lane 0', () => {
    const rows = layoutGraph([c('c', ['b']), c('b', ['a']), c('a', [])]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[2].edges).toEqual([]);
  });

  it('merge opens a second lane and closes it', () => {
    // m = merge(b, x); x -> a; b -> a
    const rows = layoutGraph([c('m', ['b', 'x']), c('x', ['a']), c('b', ['a']), c('a', [])]);
    expect(rows[0].lane).toBe(0);
    expect(rows[0].edges.map((e) => [e.from, e.to])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(rows[1].lane).toBe(1);
    expect(rows[2].lane).toBe(0);
    // a 由两列汇入
    expect(rows[3].incoming).toEqual([0, 1]);
    expect(rows[3].lane).toBe(0);
  });

  it('separate branch heads get separate lanes', () => {
    const rows = layoutGraph([c('f', ['a']), c('m', ['a']), c('a', [])]);
    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
    expect(rows[2].incoming).toEqual([0, 1]);
  });
});
