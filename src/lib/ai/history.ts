// Bounded conversation context for the AI provider. The complete transcript stays in the browser;
// only the most recent eligible turns of the *current* conversation are sent, within message-count
// and character budgets. Older turns are simply not sent (no AI summarization).

import { AI_LIMITS } from "@/lib/ai/types";

type Msg = { role: "user" | "assistant"; text: string; kind?: string; failed?: boolean; errorCode?: string };

/** Turns eligible as context: no locally answered, failed, error or engine-summary messages. */
const eligible = (m: Msg) => !m.kind && !m.failed && !m.errorCode && m.text.trim().length > 0;

export function historyFor(messages: Msg[]): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  let budget = AI_LIMITS.maxHistoryTotalChars;
  for (let i = messages.length - 1; i >= 0 && out.length < AI_LIMITS.maxHistoryTurns; i--) {
    const m = messages[i];
    if (!eligible(m)) continue;
    const text = m.text.slice(0, AI_LIMITS.maxHistoryChars);
    if (text.length > budget) break;
    budget -= text.length;
    out.unshift({ role: m.role, text });
  }
  while (out.length && out[0].role === "assistant") out.shift(); // context starts with a user turn
  return out;
}

/** How many earlier eligible messages are not sent (shown to the user, never claimed as memory). */
export function omittedCount(messages: Msg[]): number {
  return Math.max(0, messages.filter(eligible).length - historyFor(messages).length);
}
