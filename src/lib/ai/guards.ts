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
export function filterSentences(text: string, drop: (sentence: string) => boolean) {
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

const VERIFIED_CLAIM = /\b(?:verified|confirmed|official(?:ly)?|EPA|fueleconomy(?:\.gov)?|according to (?:the |autodyn's )?(?:data|dataset)|manufacturer[- ](?:rated|spec\w*|states?|lists?))\b/i;
const SPEC_FIGURE = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:hp|horsepower|bhp|ps|kw|lb[-·\s]?ft|pound[-\s]feet|n[·.\s]?m)\b/gi;

/**
 * Removes sentences that credit a horsepower/torque figure to a verified source (EPA, "verified",
 * the manufacturer) when the figure isn't in AutoDyn's data — EPA data never verifies engine output.
 */
export function stripFalseAttribution(reply: string, knownText: string) {
  const known = numbersIn(knownText);
  return filterSentences(
    reply,
    (s) => EPA_SPEC.test(s) || SPEC_PER_EPA.test(s) || (VERIFIED_CLAIM.test(s) && [...s.matchAll(SPEC_FIGURE)].some((m) => !known.some((k) => Math.abs(k - Number(m[1].replace(/,/g, ""))) < 0.51))),
  );
}

// EPA lists fuel economy, never engine output: a power/torque figure credited to EPA is always wrong,
// even when the number itself is correct (it comes from AutoDyn's dataset, not EPA).
const OUTPUT_FIGURE = String.raw`\d[\d,.]*\s*(?:hp|horsepower|bhp|kw|lb[-·\s]?ft|pound[-\s]feet|n[·.\s]?m)\b`;
const EPA_SPEC = new RegExp(String.raw`\b(?:EPA|fueleconomy(?:\.gov)?)\b(?:'s)?\s+(?:data\s+|records?\s+|listing\s+)?(?:lists?|rates?|shows?|says|states?|confirms?|reports?|gives?)\b[^.;]{0,50}?${OUTPUT_FIGURE}`, "i");
const SPEC_PER_EPA = new RegExp(String.raw`${OUTPUT_FIGURE}[^.;]{0,40}?\b(?:per|from|according to|listed by|rated by|confirmed by|verified by)\s+(?:the\s+)?(?:EPA|fueleconomy)`, "i");

const SIM_SUBJECT = /\b(?:feasibility|simulation|simulator|physics engine|autodyn|the (?:engine|model|analysis|assessment))\b/i;
const SIM_VERB = /\b(?:models?|modell?ed|evaluat\w*|accounts? for|accounted for|checks?|checked|consider(?:s|ed)?|assess(?:es|ed)?|includ(?:es|ed)|factors? in|factored in|captures?|simulat(?:es|ed)|calculat(?:es|ed)|predicts?|verif(?:ies|ied))\b/i;
const UNMODELED = /\b(?:thermal|heat(?:[- ]soak)?|cooling|coolant|temperatures? of|tolerances?|stress(?:es)?|fatigue|durability|longevity|wear|fuel (?:system|delivery|pump)|injectors?|internals|component strength|knock|detonation|oil starvation)\b/i;
const NEGATED = /\b(?:not|doesn't|does not|isn't|is not|cannot|can't|no|without|outside|beyond|unverified|ignores?)\b/i;

/**
 * Removes sentences claiming AutoDyn's simulation or feasibility engine evaluates things it doesn't
 * model (cooling, thermal stress, stock component tolerances, fuel delivery, durability). Sentences
 * that say AutoDyn does NOT model them are kept.
 */
export function stripUnmodeledClaims(reply: string) {
  return filterSentences(reply, (s) => SIM_SUBJECT.test(s) && SIM_VERB.test(s) && UNMODELED.test(s) && !NEGATED.test(s));
}

const STATUS_SUBJECT = /\b(?:simulat\w*|physics engine|analysis|results?|proposal)\b/i;
const STATUS_PENDING =
  /\b(?:not (?:yet )?(?:been )?(?:run|simulated|started|performed|executed|applied|calculated)|(?:hasn't|has not|haven't|have not|isn't|is not)(?: yet)?(?: been)? (?:run|started|simulated|performed|executed|applied|calculated)|not (?:run )?yet|until (?:you|the proposal|it is|it's)|(?:once|after|when) you (?:approve|apply|click|select|confirm|press)|pending (?:your )?(?:approval|review)|awaiting (?:your )?(?:approval|review)|(?:needs|requires) your (?:approval|review))\b|\bApply to Simulation\b/i;

/**
 * Removes the model's own statements about whether the simulation has run or what to click next.
 * AutoDyn reports that status itself from the real application state, exactly once.
 */
export function stripStatusClaims(reply: string) {
  return filterSentences(reply, (s) => /\bnothing has been simulated\b/i.test(s) || (STATUS_SUBJECT.test(s) && STATUS_PENDING.test(s)));
}

const HEADING = /^\s*(#{1,6})\s+\S|^\s*\*\*[^*\n]{1,80}\*\*:?\s*$|^\s*__[^_\n]{1,80}__:?\s*$/;
const headingLevel = (line: string) => /^\s*(#{1,6})\s/.exec(line)?.[1].length ?? 7; // bold-only label lines rank lowest

/**
 * Drops headings (and bold-only label lines) left without content, e.g. "### Expected Changes" whose
 * sentences a guard removed. A heading followed only by another heading of the same or higher rank,
 * or by the end of the reply, is empty.
 */
export function dropEmptySections(text: string) {
  let lines = text.split("\n");
  for (let pass = 0; pass < 6; pass++) {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (HEADING.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length || (HEADING.test(lines[j]) && headingLevel(lines[j]) <= headingLevel(lines[i]))) continue;
      }
      out.push(lines[i]);
    }
    if (out.length === lines.length) break;
    lines = out;
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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
