// Bounded conversation context for the AI provider. The complete transcript stays in the browser;
// only the current conversation's most recent eligible turns are sent, plus — when it has scrolled
// out of that window — the message that established the conversation's subject (and the reply to
// it), all within message-count and character budgets. Nothing is summarized by AI.

import { deriveTopic } from "@/lib/ai/topic";
import { AI_LIMITS } from "@/lib/ai/types";

type Msg = { role: "user" | "assistant"; text: string; kind?: string; localKind?: string; failed?: boolean; errorCode?: string };
type Turn = { role: "user" | "assistant"; text: string };

/** Recent turns always considered; the subject anchor may add up to two more (AI_LIMITS.maxHistoryTurns). */
export const RECENT_TURNS = 8;
const ANCHOR_REPLY_CHARS = 600;

/**
 * Turns that belong to the conversation: provider answers and our own clarifying questions (they
 * carry what the user meant). Off-topic rejections, failed requests, errors and engine summaries
 * are excluded.
 */
const eligible = (m: Msg) =>
  !m.failed && !m.errorCode && m.kind !== "results" && (m.kind !== "local" || m.localKind === "clarify") && m.text.trim().length > 0;

/**
 * Formatted answers are sent back as context in a compact form — table rules, heading marks and
 * emphasis removed, blank lines collapsed — and shortened at a sentence or line end, so detailed
 * replies don't crowd earlier turns out of the history budget.
 */
export function compactTurn(text: string, max: number = AI_LIMITS.maxHistoryChars): string {
  const plain = text
    .replace(/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const end = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return `${end >= max * 0.6 ? cut.slice(0, end + 1).trimEnd() : cut}…`;
}

export function historyFor(messages: Msg[]): Turn[] {
  const list: Turn[] = messages.filter(eligible).map((m) => ({ role: m.role, text: m.role === "assistant" ? compactTurn(m.text) : m.text }));
  let budget = AI_LIMITS.maxHistoryTotalChars;
  const picked = new Map<number, Turn>();

  // Keep the messages the current subject depends on (the vehicle that was named, both sides of a
  // comparison) when they would otherwise fall out of the window — at most two extra messages.
  const windowStart = Math.max(0, list.length - RECENT_TURNS);
  const outside = deriveTopic(list).anchors.filter((a) => a < windowStart);
  const pins = outside.length > 2 ? [outside[0], outside.at(-1)!] : outside;
  for (const a of pins) {
    const user = { role: "user" as const, text: list[a].text.slice(0, AI_LIMITS.maxHistoryChars) };
    picked.set(a, user);
    budget -= user.text.length;
  }
  const reply = pins.length === 1 ? list[pins[0] + 1] : undefined;
  if (reply?.role === "assistant" && pins[0] + 1 < windowStart) {
    const r = { role: "assistant" as const, text: compactTurn(reply.text, ANCHOR_REPLY_CHARS) };
    picked.set(pins[0] + 1, r);
    budget -= r.text.length;
  }

  let recent = 0;
  for (let i = list.length - 1; i >= windowStart && recent < RECENT_TURNS; i--) {
    const text = list[i].text.slice(0, AI_LIMITS.maxHistoryChars);
    if (text.length > budget) break;
    budget -= text.length;
    picked.set(i, { role: list[i].role, text });
    recent += 1;
  }

  const out = [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  while (out.length && out[0].role === "assistant") out.shift(); // context starts with a user turn
  return out;
}

/** How many earlier eligible messages are not sent (shown to the user, never claimed as memory). */
export function omittedCount(messages: Msg[]): number {
  return Math.max(0, messages.filter(eligible).length - historyFor(messages).length);
}
