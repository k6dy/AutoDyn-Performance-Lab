// Deterministic tracking of the conversation's automotive context — no AI calls. The context is
// derived from the user's own messages of ONE conversation (never another chat, never the vehicle
// loaded in Manual Setup), so it can always be rebuilt from stored or client-sent history.
//
// It records the subject (vehicles, engines, components), the facet being discussed (fuel economy,
// price, insurance… — see ASPECTS), whether vehicles are being compared, and what a generic question
// ("how much does it cost?") most likely refers to.

import { AMBIGUOUS_NAMES, ASPECTS, COMPONENT_TERMS, ENGINE_TERMS, MAKE_NAMES, MEDIUM_WORDS, MODELS, TRIM_TOKENS, type AspectId } from "@/lib/ai/lexicon";

/** What a generic question most likely refers to: the vehicle, a component, or a general topic. */
export type Focus = "vehicle" | "component" | "general";

/** A vehicle named in a message, with its make and model year when given ("2018 Jaguar F-Type R"). */
export type Entity = { make: string | null; model: string; year: number | null };

export type Topic = {
  /** Manufacturers, display names ("Jaguar", "BMW"). */
  makes: string[];
  /** Models / trims / codes ("M340i", "C43 AMG", "F-Type R"). */
  models: string[];
  years: number[];
  /** Engine families and induction ("V8", "supercharged"). */
  engines: string[];
  /** Components and systems ("turbochargers", "spark plugs"). */
  components: string[];
  /** Facet most recently discussed ("fuel_economy", "price"…); null for an overview. */
  aspect: AspectId | null;
  focus: Focus;
  /** Two or more vehicles are being compared. */
  comparing: boolean;
  /** Named vehicles in the subject, with make and year when known (for verified-data lookups). */
  vehicles: Entity[];
};

export type TopicMessage = { role: "user" | "assistant"; text: string };

const MODEL_SET = new Set(MODELS);
const KNOWN_MODEL_WORDS = new Set([...MODELS, ...MEDIUM_WORDS]);
const TRIMS = new Set(TRIM_TOKENS);
const ACRONYM = new Set(["amg", "gti", "wrx", "sti", "brz", "srt", "gt", "gtr", "rs", "ss", "rt", "trd", "nsx", "svr", "svx"]);
const CODE = /^[a-z]{1,3}\d{2,4}[a-z]{0,2}$/;
const YEAR = /^(?:19[3-9]\d|20[0-4]\d)$/;
/** Words that never name a model even right after a manufacturer ("BMW owners", "Jaguar V8s"). */
const NOT_MODEL = new Set(
  (
    "the a an and or vs versus to of for with in on at by from as is are was were be been has have had do does did can could should would will " +
    "it its they them their that this these those which what how why when where who than about against compared compare comparing more less " +
    "car cars vehicle vehicles engine engines motor motors model models brand brands lineup range owners owner dealer dealers parts part " +
    "reliability reliable price prices pricing mpg insurance maintenance warranty recall recalls problems issues makes make made uses used use " +
    "offers offered sells sold builds built still also really ever now today new old older newer good bad best better worse cheap expensive " +
    "sedan sedans coupe coupes suv suvs truck trucks wagon hatchback convertible turbo turbos supercharged turbocharged hybrid electric ev evs " +
    "diesel gas petrol v6 v8 v10 v12 v8s v6s i4 i6 awd rwd fwd 4wd manual automatic"
  ).split(" "),
);
/** Confirms the car meaning after a "cars or the animal?" clarification. */
const CAR_CONFIRM = /\b(?:car|cars|vehicle|vehicles|automobile|brand|make|manufacturer|automaker|engine|engines|v8|v6|v12|model|models|first one|the first|former)\b/i;
const OTHER_CONFIRM = /\b(?:animal|cat|creature|wild|zoo|second one|the second|latter|planet|horse|snake|insect|flower|president)\b/i;
const COMPARE_CUE = /\b(?:compare[ds]?|comparison|comparing|vs\.?|versus|against|better than|worse than|head to head)\b/;
const RESUME_CUE = /\b(?:back to|return(?:ing)? to|go(?:ing)? back to|again about)\b/;
const EV_MAKES = new Set(["Tesla", "Rivian", "Lucid", "Polestar", "Fisker"]);
const EV_MODELS = /^(?:Model [3SXY]|Taycan|Ioniq\b.*|Leaf|Bolt|Mach-E|Lightning|Cybertruck|EV6|EV9|ID-?4|I3|I4|IX|E-Tron.*|Kona Electric|Niro EV)$/i;
const RANGE_QUESTION =/\b(?:what about|how much|the|its|their|real[- ]world|driving|electric|total) range\b|^range\b/;

function norm(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d)\s*[‒–—―]\s*(\d)/g, "$1-$2") // 0–60
    .replace(/[‒–—―]/g, " ") // dashes between clauses ("Back to the Jaguar—what engine…")
    .replace(/[‐‑−]/g, "-")
    .replace(/[’`]/g, "'")
    .replace(/\b0\s*-\s*(60|100)\b/g, "0-$1")
    .replace(/\bquarter[\s-]mile\b/g, "quarter-mile");
}

// ---- References -----------------------------------------------------------------------------

const PRONOUN = /\b(?:it|its|it's|they|them|their|theirs|those|these|that|this|one|ones|both|either|neither|same|other|others|another)\b/;
const LEAD = /^(?:(?:what|how) about|and|but|so|also|then|ok(?:ay)?|what if|in that case|same|which|vs\.?|versus|or|back to)\b/;
const DEFINITE =
  /\bthe (?:newer|older|latest|earlier|later|base|top|other|first|second|last|cheaper|cheapest|best|worst|better|faster|slower|bigger|smaller|previous|current|new|old|same|engine|motor|price|pricing|cost|costs|mpg|range|trims?|models?|versions?|generations?|interior|ride|insurance|warranty|maintenance|reliability|transmission|gearbox|platform|car|vehicle|one|ones|v8|v6|turbo|supercharged)\b/;
const wordCount = (s: string) => (s.match(/[a-z0-9']+/g) ?? []).length;

/**
 * Structural signs that a message depends on earlier turns: pronouns ("is it reliable?"), leading
 * connectives ("what about…", "which…"), definite references without a new subject ("the
 * pricing", "the newer model") and short fragments ("Highway?"). No topic vocabulary involved.
 */
export function referenceCue(text: string): boolean {
  const n = norm(text).trim();
  return PRONOUN.test(n) || LEAD.test(n) || DEFINITE.test(n) || wordCount(n) <= 3;
}

/**
 * True when the message cannot be answered without knowing what "it" is: a pronoun, a leading
 * "what about…/which…", or a definite reference ("the MPG") — but not a self-contained question
 * such as "What is MPG?".
 */
export function needsReferent(text: string): boolean {
  const n = norm(text).trim();
  return PRONOUN.test(n) || LEAD.test(n) || DEFINITE.test(n);
}

/** Refers to a particular thing ("it", "they", "the MPG") rather than continuing a general discussion ("what about winter?"). */
export function pointsAtThing(text: string): boolean {
  const n = norm(text).trim();
  return PRONOUN.test(n) || DEFINITE.test(n);
}

const empty = (): Topic => ({ makes: [], models: [], years: [], engines: [], components: [], aspect: null, focus: "general", comparing: false, vehicles: [] });
const uniq = <T,>(xs: T[], n = 4) => [...new Set(xs)].slice(0, n);

function displayModel(w: string) {
  if (ACRONYM.has(w)) return w.toUpperCase();
  if (/\d/.test(w)) return w.replace(/^[a-z]+/, (m) => m.toUpperCase()); // c300 → C300, m340i → M340i
  return w
    .split("-")
    .map((p) => (p.length <= 3 && !/[aeiou]{2}/.test(p) ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("-"); // f-type → F-Type, xjr → XJR
}

const TRIM_DISPLAY: Record<string, string> = { xdrive: "xDrive", "4matic": "4MATIC", quattro: "quattro", "type-r": "Type R" };

function trimLabel(w: string) {
  return TRIM_DISPLAY[w] ?? (ACRONYM.has(w) || w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
}

/** Can `w` (original spelling `orig`) be a model name right after a manufacturer? */
function modelAfterMake(w: string | undefined, orig: string | undefined, strict: boolean) {
  if (!w || YEAR.test(w) || NOT_MODEL.has(w) || w.length > 16 || ENGINE_TERMS.some(([re]) => re.test(w))) return false;
  if (ASPECTS.some((a) => a.re.test(w))) return false;
  const codeLike = /\d/.test(w) || w.includes("-") || MODEL_SET.has(w);
  // After an ambiguous name ("jaguar"), only code-like names confirm the car ("Jaguar F-Type", "Jaguar XJR").
  if (strict) return codeLike || (w.length <= 3 && /^[a-z]+$/.test(w) && !/[aeiou]/.test(w.slice(1)));
  return codeLike || KNOWN_MODEL_WORDS.has(w) || /^[A-Z]/.test(orig ?? "");
}

export type Extracted = Omit<Topic, "vehicles"> & { ambiguous: string[]; entities: Entity[]; compare: boolean; resume: boolean };

/** Subject mentioned in one message. Ambiguous names (Jaguar/animal) are reported separately. */
export function extractTopic(text: string): Extracted {
  const n = norm(text);
  const origWords = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‒–—―]/g, " ")
    .replace(/[‐‑−]/g, "-")
    .replace(/[^A-Za-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const words = origWords.map((w) => w.toLowerCase());
  const t: Extracted = { ...empty(), ambiguous: [], entities: [], compare: COMPARE_CUE.test(n), resume: RESUME_CUE.test(n) };
  const withTrim = (i: number, label: string) => (words[i + 1] && TRIMS.has(words[i + 1]) ? { label: `${label} ${trimLabel(words[i + 1])}`, used: 1 } : { label, used: 0 });
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const s = w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
    const ambiguous = AMBIGUOUS_NAMES[w] ? w : AMBIGUOUS_NAMES[s] ? s : null;
    const make = MAKE_NAMES[w] ?? (ambiguous && modelAfterMake(words[i + 1], origWords[i + 1], true) ? AMBIGUOUS_NAMES[ambiguous].make : null);
    if (make) {
      t.makes.push(make);
      // "Tesla Model 3", then any model-like word after the manufacturer ("Jaguar F-Type R", "Honda Civic Si").
      const tesla = words[i + 1] === "model" && /^[3sxy]$/.test(words[i + 2] ?? "");
      if (tesla || modelAfterMake(words[i + 1], origWords[i + 1], !MAKE_NAMES[w])) {
        const at = i + (tesla ? 2 : 1);
        const { label, used } = withTrim(at, tesla ? `Model ${words[at].toUpperCase()}` : displayModel(words[at]));
        t.models.push(label);
        t.entities.push({ make, model: label, year: null });
        i = at + used;
      }
    } else if (ambiguous) t.ambiguous.push(ambiguous);
    else if (YEAR.test(w)) t.years.push(Number(w));
    else if (MODEL_SET.has(w) || MODEL_SET.has(s) || (CODE.test(w) && !/^[vwi]\d{1,2}$/.test(w))) {
      if (!ENGINE_TERMS.some(([re]) => re.test(w))) {
        const { label, used } = withTrim(i, displayModel(MODEL_SET.has(w) || CODE.test(w) ? w : s));
        t.models.push(label);
        t.entities.push({ make: null, model: label, year: null });
        i += used;
      }
    }
  }
  for (const [re, label] of ENGINE_TERMS) if (re.test(n)) t.engines.push(label);
  // Battery-electric makes and models ("range" then means battery range, not a tank).
  if (t.makes.some((mk) => EV_MAKES.has(mk)) || t.models.some((md) => EV_MODELS.test(md))) t.engines.push("electric");
  for (const [re, label] of COMPONENT_TERMS) if (re.test(n)) t.components.push(label);
  // The most specific component only ("turbo lag" over "turbochargers" when both match).
  if (t.components.includes("turbo lag")) t.components = t.components.filter((c) => c !== "turbochargers");
  t.aspect = ASPECTS.find((a) => a.re.test(n))?.id ?? (RANGE_QUESTION.test(n) ? "fuel_range" : null);
  if (t.entities.length === 1 && t.years.length === 1) t.entities[0].year = t.years[0];
  return {
    ...t,
    makes: uniq(t.makes),
    models: uniq(t.models),
    years: uniq(t.years, 3),
    engines: uniq(t.engines),
    components: uniq(t.components, 3),
    ambiguous: uniq(t.ambiguous),
    entities: t.entities.slice(0, 4),
  };
}

export function hasSubject(t: Topic | null): t is Topic {
  return !!t && t.makes.length + t.models.length + t.engines.length + t.components.length > 0;
}

/** A subject, or at least a facet under discussion ("What affects MPG?" → "What about winter?"). */
export function hasContext(t: Topic | null): t is Topic {
  return !!t && (t.makes.length + t.models.length + t.engines.length + t.components.length > 0 || !!t.aspect);
}

/** Generic facets resolved against the subject: a cost question about a car is about its price, about a part its repair. */
function resolveAspect(a: AspectId | null, t: Topic): AspectId | null {
  if (a === "cost") return t.focus === "component" ? "repairs" : t.focus === "vehicle" ? "price" : "cost";
  if (a === "fuel_range" && t.engines.includes("electric")) return "ev_range";
  return a;
}

export type Derived = {
  topic: Topic | null;
  /** Index of the message that last established the subject (kept in the bounded AI context). */
  anchor: number;
  /** Every message the current subject depends on (both sides of a comparison, a resumed vehicle). */
  anchors: number[];
  /** How the LAST user message relates to the context: started a new subject, continued it, or neither. */
  mode: "new" | "continue" | "none";
  /** Facet the LAST user message asks about — its own, or carried over by a fragment ("Highway?", "What about used?"). */
  aspect: AspectId | null;
};

/**
 * Walks the user's messages in order and keeps the context up to date: naming a vehicle replaces
 * the subject (or joins it when comparing), naming only a manufacturer seen earlier resumes that
 * vehicle ("back to the Jaguar"), engine/component mentions refine it, facet questions ("What's the
 * MPG?") keep the subject and change the facet, and an ambiguous name only counts once the car
 * meaning is confirmed.
 */
export function deriveTopic(messages: TopicMessage[]): Derived {
  let topic = empty();
  let anchors: number[] = [];
  const pin = (...idx: number[]) => (anchors = [...new Set([...anchors, ...idx])].slice(-3));
  let mode: Derived["mode"] = "none";
  let asked: AspectId | null = null;
  let pending: string[] = [];
  const seen: (Entity & { at: number })[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    mode = "none";
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
    // Ambiguous names in a sentence that is otherwise automotive (or about a make already discussed) mean the car.
    const automotive = makes.length + x.models.length + x.engines.length + x.components.length > 0 || !!x.aspect;
    if (x.ambiguous.length) {
      const known = [...topic.makes, ...seen.map((e) => e.make)].some((mk) => x.ambiguous.some((a) => AMBIGUOUS_NAMES[a].make === mk));
      if (automotive || known) makes = uniq([...makes, ...x.ambiguous.map((a) => AMBIGUOUS_NAMES[a].make)]);
      else pending = x.ambiguous;
    }
    const refers = referenceCue(m.text);
    let models = x.models;
    let years = x.years;
    let entities = x.entities;
    let resumedAt = -1;
    // A manufacturer named alone after one of its models was discussed resumes that vehicle.
    if (makes.length && !models.length) {
      const resumed = [...seen].reverse().find((e) => e.make && makes.includes(e.make));
      if (resumed && (x.resume || refers || topic.comparing || topic.models.length)) {
        models = [resumed.model];
        entities = [{ make: resumed.make, model: resumed.model, year: resumed.year }];
        resumedAt = resumed.at;
        if (!years.length) years = topic.models.length === 1 && topic.models[0] === resumed.model && topic.years.length ? topic.years : resumed.year ? [resumed.year] : [];
      }
    }
    seen.push(...x.entities.map((en) => ({ ...en, at: i })));
    const aspectOnlyBefore = !!topic.aspect && topic.makes.length + topic.models.length + topic.engines.length + topic.components.length === 0;

    if (makes.length + models.length > 0) {
      const joins = x.compare && topic.makes.length + topic.models.length > 0 && (refers || makes.length + models.length === 1);
      if (joins) {
        topic = {
          ...topic,
          makes: uniq([...topic.makes, ...makes]),
          models: uniq([...topic.models, ...models]),
          years,
          engines: x.engines.length ? x.engines : topic.engines,
          components: x.components,
          aspect: x.aspect,
          focus: "vehicle",
          comparing: true,
          vehicles: [...topic.vehicles, ...entities.filter((e) => !topic.vehicles.some((v) => v.model === e.model))].slice(0, 4),
        };
      } else {
        topic = {
          makes,
          models,
          years,
          engines: x.engines.length ? x.engines : topic.engines,
          components: x.components,
          aspect: x.aspect ?? (aspectOnlyBefore ? topic.aspect : null),
          focus: x.components.length ? "component" : "vehicle",
          comparing: models.length >= 2 || (!models.length && makes.length >= 2),
          vehicles: entities,
        };
      }
      topic.aspect = resolveAspect(topic.aspect, topic);
      mode = refers || x.resume || joins || aspectOnlyBefore ? "continue" : "new";
      if (joins) pin(i);
      else anchors = resumedAt >= 0 ? [resumedAt, i] : [i];
    } else if (x.engines.length || x.components.length) {
      if (refers && hasContext(topic)) {
        // Refines the current subject ("What about the supercharged models?", "Could spark plugs cause it?").
        topic = {
          ...topic,
          years: years.length ? years : topic.years,
          engines: x.engines.length ? uniq([...topic.engines, ...x.engines], 3) : topic.engines,
          components: x.components.length ? uniq([...x.components, ...topic.components], 3) : topic.components,
          aspect: x.aspect ?? topic.aspect,
          focus: x.components.length ? "component" : topic.focus,
        };
        mode = "continue";
        pin(i);
      } else {
        // A new general question ("How does a turbo work?") starts a new subject.
        topic = { ...empty(), years, engines: x.engines, components: x.components, aspect: x.aspect, focus: x.components.length ? "component" : "general" };
        mode = "new";
        anchors = [i];
      }
      topic.aspect = resolveAspect(topic.aspect, topic);
    } else if (x.aspect || years.length) {
      if (hasContext(topic)) {
        // A facet or model-year follow-up keeps the subject ("What's the MPG?", "What about a 2022?").
        topic = { ...topic, years: years.length ? years : topic.years, aspect: x.aspect ? resolveAspect(x.aspect, topic) : topic.aspect };
        mode = "continue";
      } else {
        topic = { ...empty(), years, aspect: x.aspect };
        mode = "new";
        anchors = [i];
      }
    } else if (refers && hasContext(topic)) mode = "continue";

    const n = norm(m.text).trim();
    const fragment = wordCount(n) <= 3 || /^(?:(?:what|how) about|and)\b/.test(n);
    asked = x.aspect ? resolveAspect(x.aspect, topic) : mode === "continue" && fragment && !x.models.length && !x.components.length ? topic.aspect : null;
  });
  return { topic: hasContext(topic) ? topic : null, anchor: anchors.at(-1) ?? -1, anchors, mode, aspect: asked };
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

export const aspectLabel = (a: AspectId | null) => (a ? (ASPECTS.find((x) => x.id === a)?.label ?? null) : null);
export const aspectClarify = (a: AspectId | null) => (a ? (ASPECTS.find((x) => x.id === a)?.clarify ?? null) : null);

/** Named vehicles (make + model, year when known) the context pins down — for verified-data lookups. */
export function pinnedVehicles(t: Topic | null): { year: number | null; make: string; model: string }[] {
  if (!t) return [];
  return t.vehicles
    .filter((v): v is Entity & { make: string } => !!v.make)
    .slice(0, 2)
    .map((v) => ({ year: (!t.comparing && t.years[0]) || v.year, make: v.make, model: v.model }));
}
