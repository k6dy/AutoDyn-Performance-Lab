// Deterministic tracking of the conversation's automotive subject — no AI calls. The subject is
// derived from the user's own messages of ONE conversation (never another chat, never the vehicle
// loaded in Manual Setup), so it can always be rebuilt from stored or client-sent history.

import { AMBIGUOUS_NAMES, COMPONENT_TERMS, ENGINE_TERMS, MAKE_NAMES, MODELS } from "@/lib/ai/lexicon";

export type Topic = {
  /** Manufacturers, display names ("Jaguar", "BMW"). */
  makes: string[];
  /** Models / trims / codes ("M340i", "C43 AMG", "C300"). */
  models: string[];
  years: number[];
  /** Engine families and induction ("V8", "supercharged"). */
  engines: string[];
  /** Components and systems ("turbochargers", "spark plugs"). */
  components: string[];
};

export type TopicMessage = { role: "user" | "assistant"; text: string };

const MODEL_SET = new Set(MODELS);
const ACRONYM = new Set(["amg", "gti", "wrx", "sti", "brz", "srt", "gt", "gtr", "rs", "ss", "rt", "trd", "nsx", "svr", "svx"]);
const CODE = /^[a-z]{1,3}\d{2,4}[a-z]{0,2}$/;
const YEAR = /^(?:19[3-9]\d|20[0-4]\d)$/;
/** Confirms the car meaning after a "cars or the animal?" clarification. */
const CAR_CONFIRM = /\b(?:car|cars|vehicle|vehicles|automobile|brand|make|manufacturer|automaker|engine|engines|v8|v6|v12|model|models|first one|the first|former)\b/i;
const OTHER_CONFIRM = /\b(?:animal|cat|creature|wild|zoo|second one|the second|latter|planet|horse|snake|insect|flower|president)\b/i;

/** The message builds on the current subject rather than starting a new one. */
const REFERS = /\b(?:it|its|that|this|those|these|they|them|their|one|ones|same|also|too|either|both|models?|versions?|variants?|trims?)\b|^\s*(?:what|how) about\b|^\s*(?:and|but|so)\b/i;

const empty = (): Topic => ({ makes: [], models: [], years: [], engines: [], components: [] });
const uniq = <T,>(xs: T[], n = 4) => [...new Set(xs)].slice(0, n);

const norm = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\b0\s*-\s*(60|100)\b/g, "0-$1");

function displayModel(w: string, next?: string) {
  let label = /\d/.test(w) ? w.replace(/^[a-z]+/, (m) => m.toUpperCase()) : w[0].toUpperCase() + w.slice(1);
  if (ACRONYM.has(w)) label = w.toUpperCase();
  if (next && ACRONYM.has(next)) label += ` ${next.toUpperCase()}`;
  return label;
}

export type Extracted = Topic & { ambiguous: string[] };

/** Subject mentioned in one message. Ambiguous names (Jaguar/animal) are reported separately. */
export function extractTopic(text: string): Extracted {
  const n = norm(text);
  const words = n.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  const t: Extracted = { ...empty(), ambiguous: [] };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const s = w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    if (MAKE_NAMES[w]) t.makes.push(MAKE_NAMES[w]);
    else if (AMBIGUOUS_NAMES[w] || AMBIGUOUS_NAMES[s]) t.ambiguous.push(AMBIGUOUS_NAMES[w] ? w : s);
    else if (YEAR.test(w)) t.years.push(Number(w));
    else if (MODEL_SET.has(w) || MODEL_SET.has(s) || (CODE.test(w) && !/^[vwi]\d{1,2}$/.test(w))) {
      if (!ENGINE_TERMS.some(([re]) => re.test(w))) {
        t.models.push(displayModel(w, words[i + 1]));
        if (words[i + 1] && ACRONYM.has(words[i + 1])) i += 1; // "C43 AMG" is one model
      }
    }
  }
  for (const [re, label] of ENGINE_TERMS) if (re.test(n)) t.engines.push(label);
  for (const [re, label] of COMPONENT_TERMS) if (re.test(n)) t.components.push(label);
  // The most specific component only ("turbo lag" over "turbochargers" when both match).
  if (t.components.includes("turbo lag")) t.components = t.components.filter((c) => c !== "turbochargers");
  return { makes: uniq(t.makes), models: uniq(t.models), years: uniq(t.years, 3), engines: uniq(t.engines), components: uniq(t.components, 3), ambiguous: uniq(t.ambiguous) };
}

export function hasSubject(t: Topic | null): t is Topic {
  return !!t && t.makes.length + t.models.length + t.engines.length + t.components.length > 0;
}

/**
 * Walks the user's messages in order and keeps the subject up to date: naming a vehicle replaces
 * the vehicle subject, engine/component mentions refine it, and an ambiguous name only counts once
 * the car meaning is confirmed. Returns the subject and the index of the message that last
 * established it (so that message can be kept in the bounded AI context).
 */
export function deriveTopic(messages: TopicMessage[]): { topic: Topic | null; anchor: number } {
  let topic = empty();
  let anchor = -1;
  let pending: string[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const x = extractTopic(m.text);
    let makes = x.makes;
    // Resolve an earlier ambiguous name ("Do jaguars purr?" → "the car" / "the V8 Jaguar").
    if (pending.length) {
      if (OTHER_CONFIRM.test(m.text) && !CAR_CONFIRM.test(m.text)) pending = [];
      else if (CAR_CONFIRM.test(m.text) || x.ambiguous.some((a) => pending.includes(a))) {
        makes = uniq([...pending.map((a) => AMBIGUOUS_NAMES[a].make), ...makes]);
        pending = [];
      }
    }
    // Ambiguous names in a sentence that is otherwise automotive mean the car.
    const automotive = makes.length + x.models.length + x.engines.length + x.components.length > 0;
    if (x.ambiguous.length) {
      if (automotive || topic.makes.some((mk) => x.ambiguous.some((a) => AMBIGUOUS_NAMES[a].make === mk))) makes = uniq([...makes, ...x.ambiguous.map((a) => AMBIGUOUS_NAMES[a].make)]);
      else pending = x.ambiguous;
    }
    const vehicle = makes.length + x.models.length > 0;
    if (!vehicle && !x.engines.length && !x.components.length) return;
    if (vehicle) {
      topic = {
        makes,
        models: x.models,
        years: x.years.length ? x.years : [],
        engines: x.engines.length ? x.engines : topic.engines,
        components: x.components.length ? x.components : [],
      };
    } else if (REFERS.test(m.text)) {
      // Refines the current subject ("What about the supercharged models?", "Could spark plugs cause it?").
      topic = {
        ...topic,
        years: x.years.length ? x.years : topic.years,
        engines: x.engines.length ? uniq([...topic.engines, ...x.engines], 3) : topic.engines,
        components: x.components.length ? uniq([...x.components, ...topic.components], 3) : topic.components,
      };
    } else {
      // A new general question ("How does a turbo work?") starts a new subject.
      topic = { ...empty(), years: x.years, engines: x.engines, components: x.components };
    }
    anchor = i;
  });
  return { topic: hasSubject(topic) ? topic : null, anchor };
}

/** "Jaguar · V8, supercharged", "M340i vs C43 AMG", "turbochargers". */
export function describeTopic(t: Topic | null): string | null {
  if (!hasSubject(t)) return null;
  const vehicles = t.models.length ? t.models : t.makes;
  const vehicleText =
    vehicles.length >= 2
      ? vehicles.join(" vs ")
      : vehicles.length === 1
        ? `${t.years.length ? `${t.years.join("/")} ` : ""}${t.makes.length && t.models.length && !t.models[0].toLowerCase().includes(t.makes[0].toLowerCase()) ? `${t.makes[0]} ` : ""}${vehicles[0]}`
        : "";
  const parts = [vehicleText, t.engines.join(", "), t.components.join(", ")].filter(Boolean);
  return parts.join(" · ").slice(0, 160) || null;
}
