"use client";

import { useMemo, type ReactNode } from "react";
import { cx } from "@/components/ui";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";

// Renders assistant text from the Markdown subset in lib/markdown as React elements. Untrusted text
// only ever becomes React text nodes (escaped), so model output can't inject markup or scripts.

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.value;
      case "strong":
        return (
          <strong key={i} className="font-semibold text-ink">
            {inline(n.children)}
          </strong>
        );
      case "em":
        return (
          <em key={i} className="italic">
            {inline(n.children)}
          </em>
        );
      case "code":
        return (
          <code key={i} className="rounded bg-raised px-1 py-px font-mono text-[12.5px] text-ink">
            {n.value}
          </code>
        );
      case "break":
        return <br key={i} />;
    }
  });
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

function block(b: Block, i: number): ReactNode {
  switch (b.type) {
    case "paragraph":
      return <p key={i}>{inline(b.children)}</p>;
    case "heading":
      return b.level === 3 ? (
        <h3 key={i} className="pt-1.5 text-[15px] leading-6 font-semibold text-ink first:pt-0">
          {inline(b.children)}
        </h3>
      ) : (
        <h4 key={i} className="pt-1 text-[14px] leading-6 font-semibold text-ink first:pt-0">
          {inline(b.children)}
        </h4>
      );
    case "list": {
      const items = b.items.map((it, j) => (
        <li key={j} className="pl-1">
          {inline(it.children)}
          {it.blocks.length > 0 && <div className="mt-1.5 space-y-2">{it.blocks.map(block)}</div>}
        </li>
      ));
      return b.ordered ? (
        <ol key={i} start={b.start} className="list-decimal space-y-1.5 pl-5 marker:text-muted">
          {items}
        </ol>
      ) : (
        <ul key={i} className="list-disc space-y-1.5 pl-5 marker:text-faint">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        // Wide tables scroll inside their own box instead of widening the page on phones.
        <div key={i} className="max-w-full overflow-x-auto rounded-md border border-line" role="region" aria-label="Table" tabIndex={0} data-md-table>
          <table className="w-full border-collapse text-[13px] leading-5 [overflow-wrap:break-word]">
            <thead className="bg-raised">
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} scope="col" className={cx("border-b border-line px-3 py-2 align-bottom font-semibold text-ink", ALIGN[b.align[j] ?? "left"])}>
                    <div className="min-w-[5.5rem]">{inline(c)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j} className="border-t border-line first:border-t-0">
                  {r.map((c, k) => (
                    <td key={k} className={cx("px-3 py-2 align-top", ALIGN[b.align[k] ?? "left"])}>
                      <div className="min-w-[5.5rem]">{inline(c)}</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "quote":
      return (
        <blockquote key={i} className="space-y-2 border-l-2 border-line-strong pl-3 text-muted">
          {b.blocks.map(block)}
        </blockquote>
      );
    case "rule":
      return <hr key={i} className="border-line" />;
  }
}

export default function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={cx("min-w-0 space-y-3", className)} data-markdown>
      {blocks.map(block)}
    </div>
  );
}
