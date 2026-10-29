// 语法高亮（D-04）：按文件扩展名选择 CodeMirror 语言包，用 lezer 解析后按行切分为 token。
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightTree } from '@lezer/highlight';

export interface Token {
  from: number;
  to: number;
  cls: string;
}

const MAX_HIGHLIGHT_CHARS = 500_000;
const cache = new Map<string, Promise<LanguageDescription | null>>();

async function languageFor(path: string): Promise<LanguageDescription | null> {
  const name = path.split('/').pop() ?? path;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) return null;
  if (!cache.has(desc.name)) {
    cache.set(
      desc.name,
      desc.load().then(
        () => desc,
        () => null,
      ),
    );
  }
  return cache.get(desc.name)!;
}

/** 返回每行的 token 列表（按行内偏移）；不支持的语言或超大文本返回 null */
export async function highlightLines(path: string, text: string | null): Promise<Token[][] | null> {
  if (!text || text.length > MAX_HIGHLIGHT_CHARS) return null;
  const desc = await languageFor(path);
  const support = desc?.support;
  if (!support) return null;
  const tree = support.language.parser.parse(text);

  // 行起始偏移（按 \n 切分，与 diffModel.splitLines 一致）
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const lines: Token[][] = starts.map(() => []);

  let line = 0;
  highlightTree(tree, classHighlighter, (from, to, cls) => {
    while (line + 1 < starts.length && starts[line + 1] <= from) line++;
    let l = line;
    let pos = from;
    while (pos < to && l < starts.length) {
      const lineEnd = l + 1 < starts.length ? starts[l + 1] - 1 : text.length;
      const end = Math.min(to, lineEnd);
      if (end > pos) lines[l].push({ from: pos - starts[l], to: end - starts[l], cls });
      l++;
      pos = l < starts.length ? starts[l] : to;
    }
  });
  return lines;
}
