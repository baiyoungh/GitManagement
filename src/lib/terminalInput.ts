/** Keep every IPC write below 64 KiB without splitting UTF-16 surrogate pairs. */
export function terminalInputChunks(data: string) {
  const chunks: string[] = [];
  for (let start = 0; start < data.length;) {
    let end = Math.min(data.length, start + 16_384);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}
