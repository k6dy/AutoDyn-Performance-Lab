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

export function historyFor(messages: Msg[]): Turn[] {
  const list: Turn[] = messages.filter(eligible).map((m) => ({ role: m.role, text: m.text }));
  let budget = AI_LIMITS.maxHistoryTotalChars;
  const picked = new Map<number, Turn>();

  // Keep the subject-establishing message when it would otherwise fall out of the window.
  const { anchor } = deriveTopic(list);
  const windowStart = Math.max(0, list.length - RECENT_TURNS);
  if (anchor >= 0 && anchor < windowStart) {
    const user = { role: "user" as const, text: list[anchor].text.slice(0, AI_LIMITS.maxHistoryChars) };
    picked.set(anchor, user);
    budget -= user.text.length;
    const reply = list[anchor + 1];
    if (reply?.role === "assistant" && anchor + 1 < windowStart) {
      const r = { role: "assistant" as const, text: reply.text.slice(0, ANCHOR_REPLY_CHARS) };
      picked.set(anchor + 1, r);
      budget -= r.text.length;
    }
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
