/** Measure complete lines, including tab stops, before rows are virtualized. */
export function widestLine(text: string | null | undefined, measure: (text: string) => number, tabWidth: number) {
  let widest = 0;
  for (const line of (text ?? '').split('\n')) {
    let width = 0;
    const parts = line.replace(/\r$/, '').split('\t');
    parts.forEach((part, i) => {
      width += measure(part);
      if (i < parts.length - 1) width = (Math.floor(width / tabWidth) + 1) * tabWidth;
    });
    widest = Math.max(widest, width);
  }
  return Math.ceil(widest);
}
