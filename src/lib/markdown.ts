// A small, safe Markdown subset for assistant replies, parsed into a block tree that the UI renders
// with React elements — never as an HTML string. Supported: paragraphs (single line breaks kept),
// headings, bold/italic, inline code, ordered and unordered (nested) lists, pipe tables, block
// quotes and rules. Links keep only their text; raw HTML is plain text; code fences show their
// content as plain text. Sizes and nesting are bounded.

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "break" };

export type Align = "left" | "center" | "right" | null;
export type ListItem = { children: Inline[]; blocks: Block[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 3 | 4; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" };

export const MARKDOWN_LIMITS = { chars: 12000, depth: 4, tableRows: 40, tableCols: 8, inlineDepth: 3 };

const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const FENCE = /^\s*(?:```|~~~)/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const leading = (line: string) => line.length - line.trimStart().length;
const isTableStart = (lines: string[], i: number) => lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-");

function dedent(lines: string[]) {
  const n = Math.min(...lines.filter((l) => l.trim()).map(leading));
  return Number.isFinite(n) ? lines.map((l) => l.slice(Math.min(n, leading(l)))) : lines;
}

// ---- Inline ---------------------------------------------------------------------------------

const WORD = /[A-Za-z0-9]/;

/** Index of the closing single "*" for emphasis opened at `from - 1`, or -1. */
function closingStar(src: string, from: number) {
  for (let j = from; j < src.length; j++) {
    if (src[j] !== "*") continue;
    if (src[j + 1] === "*") {
      j += 1;
      continue;
    }
    if (!/\s/.test(src[j - 1]) && !WORD.test(src[j + 1] ?? "")) return j;
  }
  return -1;
}

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ type: "text", value: buf });
    buf = "";
  };
  const nested = depth < MARKDOWN_LIMITS.inlineDepth;
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (ch === "\\" && /[\\`*_[\]#|>~-]/.test(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "code", value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] === "*" && nested) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2 && !/\s/.test(src[i + 2]) && !/\s/.test(src[end - 1])) {
        flush();
        out.push({ type: "strong", children: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] !== "*" && nested && !WORD.test(src[i - 1] ?? "") && src[i + 1] && !/\s/.test(src[i + 1])) {
      const end = closingStar(src, i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "em", children: parseInline(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      // [label](target) → label only: model-written links are never made clickable.
      const m = /^\[([^\]\n]{1,200})\]\(((?:[^()\s]|\([^()\s]*\)){0,500})\)/.exec(src.slice(i));
      if (m) {
        flush();
        out.push(...parseInline(m[1], depth + 1));
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

const inlineLines = (lines: string[]): Inline[] => lines.flatMap((l, i) => (i ? [{ type: "break" } as Inline, ...parseInline(l.trim())] : parseInline(l.trim())));
const plainLines = (lines: string[]): Inline[] => lines.flatMap((l, i) => (i ? [{ type: "break" } as Inline, { type: "text", value: l } as Inline] : [{ type: "text", value: l } as Inline]));

// ---- Blocks ---------------------------------------------------------------------------------

function cells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function alignOf(cell: string): Align {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

function parseList(lines: string[], start: number, depth: number): [Block, number] {
  const first = BULLET.exec(lines[start]);
  const ordered = !first;
  const firstMatch = first ?? ORDERED.exec(lines[start])!;
  const indent = firstMatch[1].length;
  const marker = ordered ? ORDERED : BULLET;
  const items: ListItem[] = [];
  let current: { text: string[]; sub: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    const sub = current.sub.some((l) => l.trim()) ? dedent(current.sub) : [];
    items.push(
      depth < MARKDOWN_LIMITS.depth
        ? { children: inlineLines(current.text), blocks: sub.length ? parseBlocks(sub, depth + 1) : [] }
        : { children: inlineLines([...current.text, ...sub.filter((l) => l.trim())]), blocks: [] },
    );
  };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless an item or indented content follows.
      const next = lines[i + 1];
      if (current && next !== undefined && next.trim() && (leading(next) > indent || (leading(next) === indent && marker.test(next)))) {
        current.sub.push("");
        i += 1;
        continue;
      }
      break;
    }
    const lead = leading(line);
    const m = lead === indent || (lead <= indent + 1 && lead >= indent) ? marker.exec(line) : null;
    if (m && (ordered ? !BULLET.test(line) : true)) {
      finish();
      current = { text: [ordered ? m[3] : m[2]], sub: [] };
      i += 1;
      continue;
    }
    if (current && lead > indent) {
      current.sub.push(line);
      i += 1;
      continue;
    }
    // Lazy continuation: an unindented plain line right after an item's text belongs to it.
    const plain = !BULLET.test(line) && !ORDERED.test(line) && !HEADING.test(line) && !QUOTE.test(line) && !FENCE.test(line) && !isTableStart(lines, i);
    if (current && plain && !current.sub.length && lines[i - 1]?.trim()) {
      current.text.push(line);
      i += 1;
      continue;
    }
    break;
  }
  finish();
  return [{ type: "list", ordered, start: ordered ? Number(firstMatch[2]) : 1, items }, i];
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", children: inlineLines(para) });
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i += 1;
      if (body.some((l) => l.trim())) blocks.push({ type: "paragraph", children: plainLines(dedent(body)) });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      if (h[2]) blocks.push({ type: "heading", level: h[1].length <= 3 ? 3 : 4, children: parseInline(h[2]) });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      flush();
      const head = cells(line).slice(0, MARKDOWN_LIMITS.tableCols);
      const align = cells(lines[i + 1]).map(alignOf).slice(0, head.length);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        if (rows.length < MARKDOWN_LIMITS.tableRows) {
          const r = cells(lines[i]);
          rows.push(head.map((_, c) => parseInline(r[c] ?? "")));
        }
        i += 1;
      }
      blocks.push({ type: "table", align: head.map((_, c) => align[c] ?? null), head: head.map((c) => parseInline(c)), rows });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      blocks.push(depth < MARKDOWN_LIMITS.depth ? { type: "quote", blocks: parseBlocks(body, depth + 1) } : { type: "paragraph", children: inlineLines(body) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      flush();
      const [list, next] = parseList(lines, i, depth);
      blocks.push(list);
      i = next;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return blocks;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.slice(0, MARKDOWN_LIMITS.chars).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines, 0);
}
