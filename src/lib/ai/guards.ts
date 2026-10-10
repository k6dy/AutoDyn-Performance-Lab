// Deterministic checks on model replies before they reach the user. Instructions tell Gemini the
// rules; these guards enforce the ones that matter most for accuracy:
//   - no calculated performance figures or "the simulation shows…" claims unless AutoDyn's physics
//     engine has produced current results;
//   - no unverified dollar figures for market prices, insurance or repairs.
// Offending sentences are removed (not reworded) and the caller adds one short status line.

import { numbersIn } from "@/lib/ai/proposal";

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9*"“(])/;
const COMPLETION_CLAIM =
  /\b(?:(?:the |this |a )?simulation (?:shows|showed|indicates|indicated|results?|found|confirms|predicts)|results? (?:show|showed|indicate|confirm)|i(?:'ve| have)? (?:ran|run|simulated|calculated)|after (?:running|applying|the (?:run|simulation))|(?:the )?(?:physics )?engine (?:shows|showed|calculated|found|predicts)|(?:now|it) (?:runs|does) (?:0-60|0–60|the quarter))\b/i;
const PERF_FIGURE = /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b|(\d+(?:\.\d+)?)\s*(?:mph|km\/h|kph)\b|(\d+(?:\.\d+)?)\s*%\s*(?:faster|quicker|slower|improvement|gain)/gi;
const PERF_WORDS = /\b(?:0-60|0–60|0 to 60|quarter[- ]mile|trap|top speed|faster|quicker|slower|acceleration|lap)\b/i;
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?\s?k?\b|\b\d{2,3}(?:\.\d)?k\b|\b\d{1,3}(?:,\d{3})+\s?(?:dollars|usd)\b/gi;

/** Applies `drop` to every sentence (and table row) of a Markdown reply; empty lines/items disappear. */
function filterSentences(text: string, drop: (sentence: string) => boolean) {
  let removed = 0;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*\|/.test(line)) {
      if (!/^\s*\|?\s*:?-+/.test(line) && drop(line)) {
        removed += 1;
        continue;
      }
      out.push(line);
      continue;
    }
    const marker = /^(\s*(?:[-*+•]|\d{1,3}[.)])\s+|\s*#{1,6}\s+)?/.exec(line)?.[0] ?? "";
    const body = line.slice(marker.length);
    const kept = body.split(SENTENCE_SPLIT).filter((s) => {
      const d = s.trim() !== "" && drop(s);
      if (d) removed += 1;
      return !d;
    });
    if (body.trim() && !kept.join("").trim()) continue; // the whole line was removed
    out.push(marker + kept.join(" "));
  }
  // Tables left with only header and separator are dropped; blank-line runs collapsed.
  const cleaned = out.join("\n").replace(/^\s*\|[^\n]*\n\s*\|?\s*:?-+[-:|\s]*\n?(?!\s*\|)/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, removed };
}

/**
 * Without current physics results (none yet, out of date, or a proposal still awaiting Apply),
 * removes sentences that claim a simulation ran or quote performance figures AutoDyn didn't compute.
 */
export function stripUnbackedPerformance(reply: string, knownText: string, opts: { figures: boolean } = { figures: true }) {
  const known = numbersIn(knownText);
  const unknownFigure = (s: string) =>
    [...s.matchAll(PERF_FIGURE)].some((m) => {
      const n = Number(m[1] ?? m[2] ?? m[3]);
      return n !== 0 && n !== 60 && n !== 100 && !known.some((k) => Math.abs(k - n) < 0.051);
    });
  return filterSentences(reply, (s) => COMPLETION_CLAIM.test(s) || (opts.figures && PERF_WORDS.test(s) && unknownFigure(s)));
}

/** Removes sentences with dollar figures that AutoDyn's data, the conversation or the user didn't supply. */
export function stripUnverifiedMoney(reply: string, knownText: string) {
  const known = numbersIn(knownText);
  return filterSentences(reply, (s) =>
    [...s.matchAll(MONEY)].some((m) => {
      const raw = m[0].replace(/[$\s,]|dollars|usd/gi, "");
      const n = Number(raw.replace(/k$/i, "")) * (/k$/i.test(raw) ? 1000 : 1);
      return Number.isFinite(n) && n > 0 && !known.some((k) => Math.abs(k - n) < 0.006);
    }),
  );
}
