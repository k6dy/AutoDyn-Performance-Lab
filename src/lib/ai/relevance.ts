// Local automotive relevance gate. Runs in the browser (instant feedback) and — authoritatively —
// in the assistant API route before any provider call, so clearly off-topic requests never spend
// Gemini quota. No network and no model are used to classify.
//
// Outcomes: CLEARLY AUTOMOTIVE ("AUTOMOTIVE") and CONTEXTUAL AUTOMOTIVE ("CONTEXTUAL_FOLLOWUP") may
// reach the provider; AMBIGUOUS gets a short, specific local clarification; CLEARLY OFF-TOPIC
// ("OFF_TOPIC") is rejected locally.
//
// Layers: (1) role-change attempts, (2) small talk, (3) explicit off-topic evidence — an off-topic
// *task* (poem, homework) always, an off-topic *topic* (weather, finance) only when automotive
// evidence doesn't outweigh it ("How does cold weather affect MPG?" is automotive), (4) answers to
// our own clarifying question, (5) ambiguous names (Jaguar the car vs the animal), (6) clear
// automotive evidence — clarified locally when it needs a referent the conversation doesn't have
// ("What's the MPG?" in a new chat), (7) everything else inside an established automotive context
// is a contextual follow-up unless it is clearly about something else (questions about the
// assistant itself, a foreign named subject), (8) without context: a facet-specific clarification
// or a rejection.
//
// The conversation context (topic.ts) is what makes short follow-ups ("What is the pricing?",
// "How much are they used?") answerable; their wording does not need to be in any list.
//
// Limitations (documented in the README): it is a heuristic, not language understanding. Unusual
// slang or rare model names in a terse first message may be asked to clarify; an off-topic
// question with no off-topic vocabulary inside a car conversation can reach the provider, whose
// system instruction keeps it in scope; creative tasks that merely mention a car are rejected.

import {
  AMBIGUOUS_NAMES,
  INJECTION_PATTERNS,
  MAKE_NAMES,
  MAKES,
  MEDIUM_WORDS,
  MODELS,
  OFF_TOPIC_PHRASES,
  OFF_TOPIC_WORDS,
  SMALL_TALK,
  STRONG_PHRASES,
  STRONG_WORDS,
  TASK_OFF_PHRASES,
  TASK_OFF_WORDS,
  type AspectId,
} from "@/lib/ai/lexicon";
import { isAppQuestion } from "@/lib/ai/appState";
import { splitParts } from "@/lib/ai/responsePlan";
import { aspectClarify, deriveTopic, extractTopic, hasContext, hasSubject, needsReferent, pointsAtThing, referenceCue, type Topic } from "@/lib/ai/topic";

export const OFF_TOPIC_REPLY = "I'm here for cars, parts, and vehicle performance. Ask me something automotive-related.";
/** Last-resort clarification when no subject can be inferred. */
export const CLARIFY_REPLY = "Which vehicle, part or system do you mean? I can help with cars, components, maintenance, modifications and vehicle performance.";
export const SMALL_TALK_REPLY = "Happy to help with anything automotive — ask about a vehicle, a part, maintenance, a modification or your AutoDyn results.";

export type RelevanceContext = {
  /** Recent turns of the current conversation only (oldest first), including our clarifying questions. */
  history: { role: "user" | "assistant"; text: string }[];
  hasVehicle: boolean;
  hasResults: boolean;
};

export type Outcome = "AUTOMOTIVE" | "CONTEXTUAL_FOLLOWUP" | "AMBIGUOUS" | "OFF_TOPIC" | "SMALL_TALK";

export type Relevance = {
  outcome: Outcome;
  /** allow = may reach the provider; everything else is answered locally with `reply`. */
  decision: "allow" | "clarify" | "reject" | "small_talk";
  basis: "automotive" | "app" | "clarified" | "follow_up" | "workspace" | "ambiguous" | "off_topic" | "injection" | "small_talk";
  score: number;
  /** The conversation's subject after this message (null when none is established). */
  topic: Topic | null;
  /** Facet this message asks about (its own, or carried by a fragment such as "Highway?"). */
  aspect: AspectId | null;
  /** The message continues an automotive context established earlier in this conversation. */
  continues: boolean;
  /** Fixed local reply when not allowed (never model-generated). */
  reply: string | null;
  /** Mixed messages: the automotive portion sent to the provider, and the unrelated questions declined locally. */
  supported?: string;
  declined?: string[];
};

/** Local note for unrelated questions bundled with automotive ones (never sent to the provider). */
export function declineNote(parts: string[]) {
  const quoted = parts.map((p) => `“${p.replace(/[?.!\s]+$/, "")}”`).join(" and ");
  return `Not answered: ${quoted} — that's outside AutoDyn's automotive scope.`;
}

/** The message without the declined questions (and the connective that joined them). */
function withoutParts(message: string, parts: string[]) {
  let out = message;
  for (const p of parts) {
    const core = p.replace(/[?.!]+$/, "").trim();
    const i = out.toLowerCase().indexOf(core.toLowerCase());
    if (i < 0) continue;
    const before = out.slice(0, i).replace(/(?:[,;]?\s*(?:and|also|plus|or)?\s*)$/i, "");
    const after = out.slice(i + core.length).replace(/^[?.!]*/, "");
    out = `${before}${/[?.!]\s*$/.test(before) || !before.trim() ? "" : "?"} ${after}`.replace(/\s+/g, " ").trim();
  }
  return out;
}

/**
 * Classifies a message for the assistant. A message bundling several questions is checked part by
 * part: if every part is unrelated it is rejected; if automotive and unrelated questions are mixed,
 * only the automotive portion may reach the provider and the rest is declined locally.
 */
export function classifyRelevance(message: string, ctx: RelevanceContext): Relevance {
  const whole = classifyOne(message, ctx);
  if (whole.basis === "injection" || whole.decision === "small_talk") return whole;
  const parts = splitParts(message);
  if (parts.length < 2) return whole;
  // Each part is read with everything before it in the message as context ("Analyze a 2015 C300.
  // Propose +60 hp. Explain what will change."). A part is declined only on positive evidence that it
  // is about something else — never merely because, on its own, it lacks automotive words.
  const lower = message.toLowerCase();
  const per = parts.map((p) => {
    const at = lower.indexOf(p.replace(/[?.!]+$/, "").trim().toLowerCase());
    const before = at > 0 ? message.slice(0, at).trim() : "";
    return classifyOne(p, { ...ctx, history: before ? [...ctx.history, { role: "user" as const, text: before }] : ctx.history });
  });
  const declined = parts.filter((p, i) => per[i].decision === "reject" && elsewhere(p));
  if (!declined.length) return whole;
  if (declined.length === parts.length) return whole.decision === "reject" ? whole : { ...per[0], reply: OFF_TOPIC_REPLY };
  const supported = withoutParts(message, declined) || parts.filter((_, i) => per[i].decision !== "reject").join(" ");
  const rest = classifyOne(supported, ctx);
  if (rest.decision === "allow") return { ...rest, supported, declined };
  if (rest.decision === "clarify") return { ...rest, reply: `${rest.reply}\n\n${declineNote(declined)}`, declined };
  return whole;
}

/** Text the gate answers locally (never generated by a model). */
export function localReply(r: Relevance): string | null {
  return r.decision === "allow" ? null : r.reply;
}

const STRONG = new Set(STRONG_WORDS);
const MEDIUM = new Set(MEDIUM_WORDS);
const MAKE = new Set(MAKES);
const MODEL = new Set(MODELS);
const OFF = new Set(OFF_TOPIC_WORDS);
const TASK = new Set(TASK_OFF_WORDS);
/** Every word the lexicon knows as automotive — used to spot foreign named subjects ("Hamlet"). */
const KNOWN = new Set([...STRONG_WORDS, ...MEDIUM_WORDS, ...MAKES, ...MODELS, ...Object.keys(MAKE_NAMES), ...Object.keys(AMBIGUOUS_NAMES)]);
// Long strong words are typo-tolerant ("turbochager", "suspention", "transmision").
const FUZZY = STRONG_WORDS.filter((w) => w.length >= 7 && /^[a-z]+$/.test(w));

const W_STRONG = 3;
const W_MEDIUM = 1.5;
const W_CODE = 2;
const W_OFF = 3;
const W_OFF_PHRASE = 4;
const ALLOW_AT = 2.5;

export function normalize(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d)\s*[‒–—―]\s*(\d)/g, "$1-$2")
    .replace(/[‒–—―]/g, " ")
    .replace(/[‐‑−]/g, "-")
    .replace(/[’`]/g, "'")
    .replace(/\blb[\s.-]*ft\b/g, "lbft")
    .replace(/\b0\s*-\s*(60|100)\b/g, "0-$1")
    .replace(/\bquarter[\s-]mile\b/g, "quarter-mile")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(norm: string) {
  const raw = norm.match(/[a-z0-9][a-z0-9'\-/.]*[a-z0-9]|[a-z0-9]/g) ?? [];
  const out = new Set<string>();
  for (const t0 of raw) {
    const t = t0.replace(/'s$/, "");
    out.add(t);
    if (t.includes("-")) {
      out.add(t.replace(/-/g, ""));
      for (const p of t.split("-")) if (p) out.add(p);
    }
  }
  return [...out];
}

function stem(t: string) {
  if (/^[a-z]{1,2}\d{1,3}s$/.test(t)) return t.slice(0, -1); // "v8s", "b58s"
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ches|shes|xes|sses)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

/** Optimal-string-alignment distance, bounded (returns max+1 when exceeded). */
function distance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

function fuzzyStrong(t: string) {
  if (t.length < 7 || !/^[a-z]+$/.test(t)) return false;
  const max = t.length >= 11 ? 2 : 1;
  return FUZZY.some((w) => Math.abs(w.length - t.length) <= max && w[0] === t[0] && distance(t, w, max) <= max);
}

const CODE_LIKE = /^[a-z]{1,3}\d{2,4}[a-z]{0,2}$/; // c300, m340i, rs6, b58, ls3, gt3
const CHASSIS_LIKE = /^(?:mk|gen)\d{1,2}$|^[efgw]\d{2,3}$/; // mk7, e46, w205
const POWER_UNITS = /\b\d+(?:[.,]\d+)?\s*(?:hp|bhp|whp|ps|kw|lbft|nm|psi|rpm|mph|kph|km\/h|mpg|cc)\b/;
const MASS_UNITS = /\b\d+(?:[.,]\d+)?\s*(?:lb|lbs|pounds|kg)\b/;

/** task: off-topic deliverables (poem, homework, recipe) — never rescued by an automotive mention. */
export type Evidence = { pos: number; neg: number; task: number; terms: string[]; ambiguous: string[]; ambiguousScore: number };

/** Automotive (pos) and off-topic (neg) evidence in one message. Each distinct term counts once. */
export function evidence(text: string): Evidence {
  const norm = normalize(text);
  const terms: string[] = [];
  const ambiguous: string[] = [];
  let pos = 0;
  let neg = 0;
  let task = 0;
  let ambiguousScore = 0;
  const seen = new Set<string>();
  const hit = (term: string, w: number, off = false) => {
    if (seen.has(term)) return;
    seen.add(term);
    terms.push(off ? `-${term}` : term);
    if (off) neg += w;
    else pos += w;
    if (off && (TASK.has(term) || TASK_OFF_PHRASES.includes(term))) task += 1;
  };

  const padded = ` ${norm.replace(/[^a-z0-9\-/ ]/g, " ").replace(/\s+/g, " ")} `;
  for (const p of STRONG_PHRASES) if (padded.includes(` ${p} `)) hit(p, W_STRONG);
  for (const p of [...OFF_TOPIC_PHRASES, ...TASK_OFF_PHRASES]) if (padded.includes(` ${p} `)) hit(p, W_OFF_PHRASE, true);
  // A model named after its manufacturer ("Jaguar F-Type R", "Skoda Kodiaq") and a facet of vehicle
  // ownership (fuel economy, price, insurance…) are automotive evidence in their own right.
  const x = extractTopic(text);
  if (x.entities.some((en) => en.make)) hit("#make-model", W_STRONG);
  if (x.aspect && x.aspect !== "cost") hit(`#${x.aspect}`, W_MEDIUM);
  if (POWER_UNITS.test(norm)) hit("#power-unit", W_STRONG);
  if (MASS_UNITS.test(norm)) hit("#mass-unit", W_MEDIUM);
  // A model year followed by a capitalized name ("2015 Yugo GV") usually names a vehicle.
  if (/\b(?:19[3-9]\d|20[0-4]\d)\s+[A-Z][A-Za-z-]+/.test(text)) hit("#year-name", W_MEDIUM);

  for (const t of tokens(norm)) {
    const s = stem(t);
    if (STRONG.has(t) || STRONG.has(s)) hit(s, W_STRONG);
    else if (MAKE.has(t) || MODEL.has(t) || MODEL.has(s)) hit(t, W_STRONG);
    else if (AMBIGUOUS_NAMES[t] || AMBIGUOUS_NAMES[s]) {
      const name = AMBIGUOUS_NAMES[t] ? t : s;
      if (!ambiguous.includes(name)) {
        ambiguous.push(name);
        ambiguousScore += W_MEDIUM;
      }
      hit(name, W_MEDIUM);
    } else if (OFF.has(t) || OFF.has(s)) hit(s, W_OFF, true);
    else if (MEDIUM.has(t) || MEDIUM.has(s)) hit(s, W_MEDIUM);
    else if (CODE_LIKE.test(t)) hit(t, W_CODE);
    else if (CHASSIS_LIKE.test(t)) hit(t, W_MEDIUM);
    else if (fuzzyStrong(t)) hit(`~${t}`, W_STRONG);
  }
  return { pos, neg, task, terms, ambiguous, ambiguousScore };
}

/** Text outside quotation marks, so quoted phrases ("ignore the light") aren't read as commands. */
const unquoted = (text: string) => text.replace(/"[^"]*"|“[^”]*”|'[^']{4,}'/g, " ");

export function isInjection(text: string) {
  const n = normalize(text);
  return INJECTION_PATTERNS.some((re) => re.test(n));
}

const NAME_CLARIFY = /^Do you mean .+ or .+\?$/;
const CAR_CONFIRM = /\b(?:car|cars|vehicle|vehicles|automobile|brand|make|manufacturer|automaker|engine|engines|v8|v6|v12|model|models|first one|the first|former)\b/i;
const OTHER_CONFIRM = /\b(?:animal|cat|creature|wild|zoo|second one|the second|latter|planet|horse|snake|insect|flower|president|element)\b/i;
const WORKSPACE_REF = /\b(?:my|this|the|current|our)\s+(?:build|setup|set-up|configuration|config|scenario|scenarios|vehicle|car|ride|results?|analysis|simulation|numbers|run)\b/;

/** Questions about the assistant itself ("How old are you?") — unless they ask for advice or refer to the subject. */
const ABOUT_ASSISTANT = /\b(?:you|your|yourself|ur)\b/;
const ADVICE =
  /\b(?:recommend|suggest|buy|get|choose|pick|prefer|think|rate|say|explain|tell|help|compare|know|consider|advise|take|drive|own|mean|clarify|expand|elaborate|show|give|list|describe|calculate|estimate|simulate|analy[sz]e|check|find|summari[sz]e|would|could|can|should)\b/;
const aboutAssistant = (text: string) => ABOUT_ASSISTANT.test(normalize(text)) && !ADVICE.test(normalize(text));

/** General explanations that need no particular vehicle ("How does…", "Why…", "What affects…"). */
const GENERAL_QUESTION = /^(?:how (?:does|do|is|are|can|could|would)|why|what (?:affects?|causes?|is|are|does|do|makes?|happens)|explain|define|describe|tell me about|difference|which (?:cars|vehicles|suvs|trucks|models)\b)/;

/** A capitalized name the lexicon doesn't know ("Who wrote Hamlet?") — a subject of its own, not a follow-up. */
function foreignName(text: string) {
  const words = text.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  return words.slice(1).some((w) => /^\p{Lu}\p{Ll}{2,}$/u.test(w) && !KNOWN.has(w.toLowerCase().replace(/'s$/, "")));
}

/** Positive evidence that a message is about something other than vehicles (not just a lack of car words). */
function elsewhere(text: string) {
  const e = evidence(text);
  return e.task > 0 || e.neg > 0 || foreignName(text) || (aboutAssistant(text) && !isAppQuestion(text));
}

/** Clarifying question that names what is missing instead of a generic prompt. */
function clarifyFor(text: string, aspect: AspectId | null) {
  const specific = aspectClarify(aspect);
  if (specific) return specific;
  const n = normalize(text);
  if (/\b(?:models?|trims?|years?|versions?|variants?|generations?)\b/.test(n)) return "Which manufacturer or model line do you mean?";
  if (/\b(?:power|fast|faster|quick|quicker|speed|acceleration|0-60)\b/.test(n)) return "Which vehicle do you mean? Name the model, or load one in Manual Setup.";
  return CLARIFY_REPLY;
}

/**
 * Classifies a message for the assistant. Only AUTOMOTIVE and CONTEXTUAL_FOLLOWUP may reach the
 * AI provider; everything else is answered locally with a fixed text.
 */
function classifyOne(message: string, ctx: RelevanceContext): Relevance {
  const text = message.trim();
  const e = evidence(text);
  const score = e.pos - e.neg;
  const prior = deriveTopic(ctx.history).topic;
  const derived = deriveTopic([...ctx.history, { role: "user", text }]);
  const result = (outcome: Outcome, basis: Relevance["basis"], reply: string | null = null): Relevance => {
    const after = outcome === "OFF_TOPIC" ? null : derived;
    return {
      outcome,
      decision: outcome === "AUTOMOTIVE" || outcome === "CONTEXTUAL_FOLLOWUP" ? "allow" : outcome === "AMBIGUOUS" ? "clarify" : outcome === "SMALL_TALK" ? "small_talk" : "reject",
      basis,
      score,
      topic: after ? after.topic : prior,
      aspect: after?.aspect ?? null,
      continues: !!after && after.mode === "continue" && hasContext(prior),
      reply,
    };
  };

  // 1. Attempts to change the assistant's role. Quoted text alone doesn't count when the rest of
  //    the message is a genuine automotive question.
  const outside = unquoted(text);
  if (isInjection(outside)) return result("OFF_TOPIC", "injection", OFF_TOPIC_REPLY);
  if (isInjection(text)) {
    const o = evidence(outside);
    if (!(o.pos >= ALLOW_AT && o.neg === 0)) return result("OFF_TOPIC", "injection", OFF_TOPIC_REPLY);
  }
  // 2. Greetings and thanks.
  if (SMALL_TALK.test(text)) return result("SMALL_TALK", "small_talk", SMALL_TALK_REPLY);

  // 3. Explicit off-topic content. A non-automotive task (poem, homework, recipe) is always rejected;
  //    an off-topic subject word only when automotive evidence doesn't outweigh it, so cross-domain
  //    questions ("How does cold weather affect MPG?") stay allowed. A previous car discussion never
  //    authorizes an unrelated question.
  const definite = e.pos - e.ambiguousScore;
  if (e.task > 0) return result("OFF_TOPIC", "off_topic", OFF_TOPIC_REPLY);
  if (e.neg > 0 && definite < Math.max(ALLOW_AT, e.neg + W_MEDIUM)) return result("OFF_TOPIC", "off_topic", OFF_TOPIC_REPLY);
  // 3b. Questions about AutoDyn itself — its simulation, proposals, results, feasibility, saving —
  //     are always in scope ("Have you actually run the simulation yet?").
  if (isAppQuestion(text)) return result("AUTOMOTIVE", "app");

  // 4. The answer to our own "cars or the animal?" question.
  const last = ctx.history.at(-1);
  if (last?.role === "assistant" && NAME_CLARIFY.test(last.text.trim()) && e.neg === 0) {
    if (OTHER_CONFIRM.test(text) && !CAR_CONFIRM.test(text)) return result("OFF_TOPIC", "off_topic", OFF_TOPIC_REPLY);
    if (CAR_CONFIRM.test(text) || e.pos > 0) return result("AUTOMOTIVE", "clarified");
  }

  // 5. Names that are also everyday words (Jaguar, Mustang, Lincoln…) need more than the name.
  if (e.ambiguous.length && definite < ALLOW_AT && e.neg === 0) {
    const makes = e.ambiguous.map((a) => AMBIGUOUS_NAMES[a].make);
    if (prior?.makes.some((m) => makes.includes(m)) || prior?.models.some((m) => makes.some((mk) => mk.endsWith(m)))) return result("CONTEXTUAL_FOLLOWUP", "follow_up");
    const a = AMBIGUOUS_NAMES[e.ambiguous[0]];
    return result("AMBIGUOUS", "ambiguous", `Do you mean ${a.car} or ${a.other}?`);
  }

  const x = extractTopic(text);
  const ownSubject = x.makes.length + x.models.length + x.engines.length + x.components.length + x.ambiguous.length > 0;
  const context = hasContext(prior);
  // Something to refer to: this conversation's subject, or the vehicle/results loaded in AutoDyn.
  const referent = hasSubject(prior) || ctx.hasVehicle || ctx.hasResults;

  // A facet question about an unnamed vehicle ("How many miles on a tank?", "Is insurance
  // expensive?") as opposed to a general one ("How does cold weather affect MPG?").
  const propertyQuestion = !!x.aspect && !GENERAL_QUESTION.test(normalize(text)) && (normalize(text).match(/[a-z0-9']+/g) ?? []).length <= 8;

  // 6. Clearly automotive — unless it asks about "it" when there is nothing to refer to
  //    ("What's the MPG?" in a new chat): then ask which vehicle, locally.
  if (e.pos >= ALLOW_AT) {
    if (!referent && !ownSubject && (needsReferent(text) || propertyQuestion)) return result("AMBIGUOUS", "ambiguous", clarifyFor(text, x.aspect));
    const continues = context && derived.mode === "continue";
    return result(continues ? "CONTEXTUAL_FOLLOWUP" : "AUTOMOTIVE", continues ? "follow_up" : "automotive");
  }

  // From here on there is no off-topic evidence (step 3) and little automotive vocabulary.
  // 7a. References to the configured vehicle or computed results ("explain my results").
  if ((ctx.hasVehicle || ctx.hasResults) && WORKSPACE_REF.test(normalize(text))) return result("AUTOMOTIVE", "workspace");
  // 7b. Inside an automotive conversation, a message is read against its context ("What is the
  //     pricing?", "How much are they used?", "Would you buy one at that price?") unless it is
  //     clearly about something else: the assistant itself, or a named subject of its own.
  if (context) {
    const elsewhere = !needsReferent(text) && !x.aspect && (aboutAssistant(text) || foreignName(text));
    if (elsewhere) return result("OFF_TOPIC", "off_topic", OFF_TOPIC_REPLY);
    // A facet discussed without any vehicle yet ("What is the pricing?" → our question) gives "it" nothing to point at.
    if (!hasSubject(prior) && !ownSubject && !ctx.hasVehicle && pointsAtThing(text) && (x.aspect || propertyQuestion)) return result("AMBIGUOUS", "ambiguous", clarifyFor(text, x.aspect));
    return result("CONTEXTUAL_FOLLOWUP", "follow_up");
  }
  // 8. No automotive context. A follow-up to an off-topic question stays off-topic ("Do cows
  //    hibernate?" → "Why?"); a question about a facet or "it" gets a specific clarification.
  const lastUser = [...ctx.history].reverse().find((h) => h.role === "user");
  if (lastUser && referenceCue(text) && evidence(lastUser.text).neg > 0) return result("OFF_TOPIC", "off_topic", OFF_TOPIC_REPLY);
  if (aboutAssistant(text) && !x.aspect) return result("OFF_TOPIC", "off_topic", OFF_TOPIC_REPLY);
  if (x.aspect || e.pos > 0 || needsReferent(text)) return result("AMBIGUOUS", "ambiguous", clarifyFor(text, x.aspect));
  return result("OFF_TOPIC", "off_topic", OFF_TOPIC_REPLY);
}
