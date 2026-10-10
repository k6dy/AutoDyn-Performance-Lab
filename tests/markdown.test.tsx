// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Markdown from "@/components/assistant/Markdown";
import { MARKDOWN_LIMITS, parseInline, parseMarkdown } from "@/lib/markdown";

afterEach(cleanup);

const view = (text: string) => render(<Markdown text={text} />).container.querySelector("[data-markdown]") as HTMLElement;

describe("Markdown subset parser", () => {
  it("separates paragraphs on blank lines and keeps single line breaks", () => {
    expect(parseMarkdown("First line\nsecond line\n\nNew paragraph")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "First line" }, { type: "break" }, { type: "text", value: "second line" }] },
      { type: "paragraph", children: [{ type: "text", value: "New paragraph" }] },
    ]);
  });

  it("parses headings, emphasis, inline code and keeps link text only", () => {
    const [h, p] = parseMarkdown("## Boost control\nUse **wastegate duty**, *not* `ignition` — see [the guide](javascript:alert(1)).");
    expect(h).toEqual({ type: "heading", level: 3, children: [{ type: "text", value: "Boost control" }] });
    expect(JSON.stringify(p)).toContain('"type":"strong"');
    expect(JSON.stringify(p)).toContain('"type":"em"');
    expect(JSON.stringify(p)).toContain('"type":"code","value":"ignition"');
    expect(JSON.stringify(p)).not.toContain("javascript");
  });

  it("does not treat arithmetic or spaced asterisks as emphasis", () => {
    expect(parseInline("5*4*3 and 2 * 3 * 4")).toEqual([{ type: "text", value: "5*4*3 and 2 * 3 * 4" }]);
    expect(parseInline("\\*literal\\*")).toEqual([{ type: "text", value: "*literal*" }]);
  });

  it("parses ordered, unordered and nested lists", () => {
    const blocks = parseMarkdown("Intro:\n1. Wastegate\n   - exhaust side\n   - caps boost\n2. Blow-off valve\n\n- loose\n- tight");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "list"]);
    const ol = blocks[1] as Extract<(typeof blocks)[number], { type: "list" }>;
    expect(ol).toMatchObject({ ordered: true, start: 1 });
    expect(ol.items).toHaveLength(2);
    expect(ol.items[0].blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect((ol.items[0].blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("parses pipe tables with alignment and bounds their size", () => {
    const [t] = parseMarkdown("| Part | Side | Opens |\n|:--|:-:|--:|\n| Wastegate | Exhaust | At target boost |\n| BOV | Intake | Throttle lift |");
    expect(t).toMatchObject({ type: "table", align: ["left", "center", "right"] });
    expect((t as { rows: unknown[] }).rows).toHaveLength(2);
    const rows = Array.from({ length: 80 }, (_, i) => `| ${i} | x |`).join("\n");
    const [big] = parseMarkdown(`| a | b |\n|---|---|\n${rows}`);
    expect((big as { rows: unknown[] }).rows).toHaveLength(MARKDOWN_LIMITS.tableRows);
  });

  it("shows code fences and HTML as plain text", () => {
    const blocks = parseMarkdown("```\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>");
    expect(JSON.stringify(blocks)).toContain("<script>alert(1)</script>");
    expect(blocks.every((b) => b.type === "paragraph")).toBe(true);
  });
});

describe("Markdown rendering in the chat", () => {
  it("renders paragraphs, line breaks, headings, lists and tables as real elements", () => {
    const el = view("### Wastegate\nBypasses the turbine.\nCaps boost.\n\n### Blow-off valve\n1. Vents intake pressure\n2. Protects the compressor\n\n- **Key:** different jobs\n\n| Part | Side |\n|---|---|\n| Wastegate | Exhaust |");
    expect([...el.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Wastegate", "Blow-off valve"]);
    expect(el.querySelectorAll("p")).toHaveLength(1);
    expect(el.querySelector("p")!.querySelectorAll("br")).toHaveLength(1);
    expect(el.querySelectorAll("ol > li")).toHaveLength(2);
    expect(el.querySelector("ul > li strong")!.textContent).toBe("Key:");
    const region = el.querySelector("[data-md-table]")!;
    expect(region.className).toMatch(/overflow-x-auto/);
    expect(region.getAttribute("role")).toBe("region");
    expect(region.querySelectorAll("th")).toHaveLength(2);
    expect(region.querySelector("td")!.textContent).toBe("Wastegate");
  });

  it("never creates elements or runs scripts from model text", () => {
    const w = window as unknown as { __xss?: number };
    delete w.__xss;
    const el = view('<script>window.__xss=1</script>\n\n<img src="x" onerror="window.__xss=2">\n\n**<b onclick="x()">bold</b>**\n\n[click](javascript:window.__xss=3)');
    expect(el.querySelector("script, img, b, a, iframe")).toBeNull();
    expect(el.textContent).toContain("<script>window.__xss=1</script>");
    expect(el.textContent).toContain("click");
    expect(w.__xss).toBeUndefined();
  });

  it("deterministic results summaries keep their list layout", () => {
    const el = view("Physics engine results for 2015 Mercedes-Benz C300, stock → modified:\n- 0–60 mph 6.1 s → 5.6 s (−0.5 s)\n- Quarter mile 14.6 s → 14.1 s");
    expect(el.querySelector("p")!.textContent).toMatch(/^Physics engine results/);
    expect(el.querySelectorAll("li")).toHaveLength(2);
  });

  it("short answers stay a single paragraph", () => {
    const el = view("RPM means revolutions per minute — how many times the crankshaft turns each minute.");
    expect(el.children).toHaveLength(1);
    expect(el.firstElementChild!.tagName).toBe("P");
  });
});
