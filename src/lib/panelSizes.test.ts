import { describe, expect, it } from 'vitest';
import { fitPanelSizes, normalizeSizes, resizePanelPair } from './panelSizes';

describe('panel sizing', () => {
  it('recovers invalid saved preferences', () => {
    expect(normalizeSizes([NaN, 20], 2)).toEqual([50, 50]);
    expect(normalizeSizes([20], 2)).toEqual([50, 50]);
  });

  it('reserves minimum widths and preserves the remaining proportions', () => {
    expect(fitPanelSizes([10, 30, 60], [200, 100, 100], 1000)).toEqual([20, 80 / 3, 160 / 3]);
  });

  it('fits all panes within a window smaller than their minimum widths', () => {
    const result = fitPanelSizes([20, 80], [200, 600], 400);
    expect(result).toEqual([25, 75]);
    expect(result.reduce((a, b) => a + b)).toBeCloseTo(100);
  });

  it('only resizes neighbors and stops at either minimum', () => {
    expect(resizePanelPair([20, 30, 50], 1, 900, [100, 100, 200], 1000)).toEqual([20, 60, 20]);
    expect(resizePanelPair([20, 30, 50], 1, -900, [100, 100, 200], 1000)).toEqual([20, 10, 70]);
  });
});
