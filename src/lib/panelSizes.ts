export function normalizeSizes(values: number[], count: number): number[] {
  const valid = values.length === count && values.every((v) => Number.isFinite(v) && v > 0);
  const sizes = valid ? values : Array(count).fill(1);
  const total = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((v) => (v / total) * 100);
}

export function minimumPercentages(minimums: number[], available: number): number[] {
  const percentages = minimums.map((v) => Math.max(0, v) * 100 / Math.max(1, available));
  const sum = percentages.reduce((a, b) => a + b, 0);
  return sum > 100 ? percentages.map((v) => v * 100 / sum) : percentages;
}

export function fitPanelSizes(preferred: number[], minimums: number[], available: number): number[] {
  const weights = normalizeSizes(preferred, minimums.length);
  if (available <= 0) return weights;
  const mins = minimumPercentages(minimums, available);
  const result = weights.map(() => 0);
  let remaining = 100;
  let active = weights.map((_, i) => i);
  // Reserve undersized panes first, then distribute the remaining space by preference.
  while (active.length) {
    const total = active.reduce((sum, i) => sum + weights[i], 0);
    const small = active.filter((i) => remaining * weights[i] / total < mins[i]);
    if (!small.length) {
      active.forEach((i) => { result[i] = remaining * weights[i] / total; });
      break;
    }
    small.forEach((i) => { result[i] = mins[i]; remaining -= mins[i]; });
    active = active.filter((i) => !small.includes(i));
  }
  return result;
}

export function resizePanelPair(sizes: number[], index: number, delta: number, minimums: number[], available: number): number[] {
  if (available <= 0 || index < 0 || index >= sizes.length - 1) return sizes;
  const mins = minimumPercentages(minimums, available);
  const pair = sizes[index] + sizes[index + 1];
  const first = Math.min(pair - mins[index + 1], Math.max(mins[index], sizes[index] + delta * 100 / available));
  return sizes.map((value, i) => i === index ? first : i === index + 1 ? pair - first : value);
}
