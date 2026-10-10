// Deterministic response planning — no AI calls. Reads the user's message for how deep the answer
// should go, who it is for and which distinct questions it contains, so the single provider request
// can be told how to shape its answer and given a matching, bounded output budget.

export type Depth = "brief" | "standard" | "detailed";
export type Audience = "beginner" | "technical" | null;

export type ResponsePlan = {
  depth: Depth;
  audience: Audience;
  /** Distinct questions or topics, in order; empty when the message asks one thing. */
  parts: string[];
  comparison: boolean;
  recommendation: boolean;
  /** The user explicitly asked for more or less detail. */
  explicit: "more" | "less" | null;
  followUp: boolean;
};

/**
 * Output-token ceilings per depth (they include any model thinking tokens). Only generated tokens
 * are billed, so a ceiling bounds runaway answers without making short answers more expensive.
 */
export const OUTPUT_BUDGET: Record<Depth, number> = { brief: 1024, standard: 2048, detailed: 4096 };

const MORE =
  /\b(?:in (?:more |greater |great |full |much more )?detail|detailed|go(?:ing)? deeper|dig deeper|deep[- ]?dive|in[- ]depth|elaborate|thorough(?:ly)?|comprehensive(?:ly)?|break (?:it |this |that |them )?down|breakdown|every (?:part|step|component|detail)|step[- ]by[- ]step|walk me through|full explanation|technical explanation|explain the (?:physics|engineering|maths?|theory|science)|the physics|tell me (?:more|everything)|more (?:detail|depth|info(?:rmation)?)|expand on)\b/i;
const LESS =
  /\b(?:briefly|short answer|in short|keep it (?:short|brief|simple)|quick (?:answer|summary|version)|tl;?dr|in (?:one|a) (?:sentence|line|word)|one[- ]liner|in a nutshell|just (?:tell me|the answer)|yes or no|summari[sz]e)\b/i;
const BEGINNER =
  /\b(?:beginners?|newbie|novice|eli5|like i'?m (?:five|5|a (?:kid|child|beginner|newbie|novice))|for (?:a )?(?:dummies|non[- ]?car (?:person|people))|lay(?:man|person|men)'?s? terms|simple terms|plain (?:english|language|terms)|simply|simpler|non[- ]?technical|new to cars|without (?:the )?jargon|easy to understand)\b/i;
const TECHNICAL =
  /\b(?:technical(?:ly)?|engineering|physics|equations?|formulas?|formulae|maths?|mathematical(?:ly)?|thermodynamics?|thermodynamical(?:ly)?|quantitative(?:ly)?|calculations?|derive|derivation)\b/i;
const COMPARE =
  /\b(?:compare[ds]?|comparison|comparing|versus|vs\.?|differences? between|differ(?:s|ence)?|better than|worse than|or the|which (?:is|one|of)|pros and cons|trade-?offs?)\b/i;
const COMPARE_VERB = /\b(?:compare[ds]?|comparison|comparing|versus|vs\.?)\b/i;
const RECOMMEND =
  /\b(?:recommend(?:ation|ed)?|should i (?:buy|get|choose|pick|go)|which (?:one )?(?:would|should) (?:you|i)|best (?:choice|option|one|buy)|worth (?:it|buying|getting))\b/i;
const RELATIONSHIP = /\b(?:how|why)\b.*\b(?:affects?|influences?|relates?|relationships?|interacts?|impacts?|determines?|changes?|limits?|trade[- ]?offs?)\b/i;
const DEFINITION =
  /^(?:what(?:'s| is| are| does| do)|define)\b.{0,48}\b(?:mean|stand for|short for|abbreviation|acronym)\b|^(?:what(?:'s| is| are)) (?!.*\b(?:it|this|that|they|them|those|these|ones?|models?|options?|versions?|trims?|engines?|problems?|issues?|differences?|years?)\b)(?:an? |the )?[\w./-]+(?: [\w./-]+)?\s*\?*$/i;
const YES_NO = /^(?:is|are|does|do|did|can|could|will|would|has|have|was|were)\b/i;
const EVALUATIVE = /\b(?:reliab|problem|issue|fail|differ|compar|better|worse|best|worth|safe|recommend|why|how|pros|cons|explain|should|tune|upgrade|mod)/i;

const Q_START =
  /^(?:what|what's|whats|how|how's|why|which|who|when|where|whether|is|are|was|were|does|do|did|can|could|should|would|will|has|have|isn't|aren't|doesn't|don't)\b/i;
const VERB_START = /^(?:explain|describe|compare|define|tell me|list|give me|show me|walk me through|break down|summari[sz]e|outline|recommend|name)\b/i;
const NOUN_LIST = /^(?:(?:can|could) you |please )?(?:explain|describe|define|tell me about|what are|what're)\s+(?!(?:how|why|what|whether|if|when|where|the differences?|differences?)\b)(.+)$/i;
const FILLER = /^(?:(?:and|also|ok(?:ay)?|so|then|plus|but|hey|hi|now)\b[,\s]*)+/i;
/** Sentence ends: after ?/! always; after a period only before a capital or a question/request word. */
const SENTENCE_END = /(?<=[?!])\s+|(?<=(?<!\b(?:vs|etc|approx|incl|e\.g|i\.e))\.)\s+(?=[A-Z]|(?:what|how|why|which|explain|compare|describe|also)\b)/;
const CLAUSE_SEP = /(\s*[,;]\s*(?:and|or|plus|also|then)?\s*|\s+(?:and|plus|also|then|or)\s+)/i;
const MAX_PARTS = 6;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const clean = (s: string) => s.replace(FILLER, "").trim();
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const asks = (s: string) => Q_START.test(s) || VERB_START.test(s);

/** Clauses of one sentence that start a new question ("…, and which one is more important?"). */
function clauses(sentence: string): string[] {
  const pieces = sentence.split(CLAUSE_SEP);
  const out: string[] = [];
  for (let i = 0; i < pieces.length; i += 2) {
    const seg = pieces[i].trim();
    if (!seg) continue;
    // A clause stands alone only when it asks something and neither it nor the previous one is a
    // fragment ("Briefly, what is…", "…, and why?").
    if (!out.length || (asks(seg) && words(seg) >= 3 && words(out[out.length - 1]) >= 3)) out.push(seg);
    else out[out.length - 1] += `${pieces[i - 1] ?? " "}${seg}`;
  }
  // A leading statement ("I have a turbo car, how often…") is context for the question after it.
  if (out.length > 1 && !asks(out[0])) out.splice(0, 2, `${out[0]}, ${out[1]}`);
  return out;
}

/** "Explain a wastegate, a blow-off valve and an intercooler." → the three topics. */
function nounList(sentence: string): string[] {
  const m = NOUN_LIST.exec(sentence.replace(/[.?!]+$/, "").trim());
  if (!m) return [];
  const items = m[1].split(/\s*,\s*(?:and\s+|or\s+)?|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
  if (items.length < 2 || items.some((s) => words(s) > 5 || Q_START.test(s) || /\b(?:affects?|works?|does|do|is|are)\b/i.test(s))) return [];
  return items;
}

/** Distinct questions/topics in a message, in order (empty for a single question). */
export function splitParts(message: string): string[] {
  const text = message.replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  for (const raw of text.split(SENTENCE_END)) {
    const sentence = clean(raw);
    // Statements ("My car shakes at idle.") are context for the questions, not parts of their own.
    if (!sentence || !(/\?\s*$/.test(sentence) || asks(sentence) || NOUN_LIST.test(sentence))) continue;
    const cs = clauses(sentence);
    if (cs.length > 1) parts.push(...cs);
    else {
      const list = nounList(sentence);
      parts.push(...(list.length ? list : [sentence]));
    }
  }
  const out = parts.map((p) => capitalize(clean(p))).filter((p) => words(p) >= 1);
  return out.length >= 2 ? out.slice(0, MAX_PARTS) : [];
}

function listCount(text: string) {
  return (text.match(/,/g)?.length ?? 0) + (/\band\b/i.test(text) ? 1 : 0) + 1;
}

export function planResponse(message: string, opts: { detail?: boolean; followUp?: boolean } = {}): ResponsePlan {
  const text = message.replace(/\s+/g, " ").trim();
  const n = words(text);
  const parts = splitParts(text);
  const comparison = COMPARE.test(text);
  const recommendation = RECOMMEND.test(text);
  const more = !!opts.detail || MORE.test(text);
  const less = LESS.test(text);
  const explicit = more && !less ? "more" : less && !more ? "less" : null;
  const audience: Audience = BEGINNER.test(text) ? "beginner" : TECHNICAL.test(text) ? "technical" : null;
  const followUp = !!opts.followUp;

  let depth: Depth = "standard";
  if (explicit === "less") depth = "brief";
  else if (explicit === "more") depth = "detailed";
  else if (more && less) depth = "standard";
  else if (parts.length >= 3) depth = "detailed";
  else if (audience === "technical" && n >= 10) depth = "detailed";
  else if (RELATIONSHIP.test(text) && (n >= 14 || listCount(text) >= 3)) depth = "detailed";
  else if (COMPARE_VERB.test(text) && n >= 5) depth = "detailed";
  else if (
    !parts.length &&
    audience !== "beginner" &&
    !comparison &&
    !recommendation &&
    (DEFINITION.test(text) || (YES_NO.test(text) && n <= 7 && !EVALUATIVE.test(text)))
  )
    depth = "brief";

  return { depth, audience, parts, comparison, recommendation, explicit, followUp };
}

const DEPTH_TEXT: Record<Depth, string> = {
  brief: "brief — answer directly in 1–3 sentences (about 60 words at most); no headings or lists.",
  standard:
    "standard — a clear explanation in a few short paragraphs or a compact list (about 120–300 words): the core mechanism or answer, why it matters, and the main limitation or caveat. Skip side topics.",
  detailed:
    "detailed — a substantive, organized answer (about 300–700 words) in short sections: explain how the factors relate (cause → effect), give a concrete example where it helps, and state the assumptions and limits.",
};

/** Per-message instructions for the provider (sent in the user turn, after CONTEXT). */
export function describePlan(plan: ResponsePlan): string {
  const lines = [`- Depth: ${DEPTH_TEXT[plan.depth]}`];
  if (plan.audience === "beginner") lines.push("- Audience: beginner — plain language; define each technical term in a few words when first used; an everyday analogy helps. Stay accurate.");
  if (plan.audience === "technical")
    lines.push("- Audience: technical — precise terminology, the governing relationships (simple plain-text equations such as P = T × ω are fine), typical magnitudes with units, and stated assumptions.");
  if (plan.followUp) {
    lines.push(
      plan.explicit === "more"
        ? "- Follow-up: the user wants more depth on the previous answer — extend it with mechanisms, relationships and examples instead of restating it."
        : plan.explicit === "less"
          ? "- Follow-up: the user wants a shorter version of the previous answer — condense it to the essentials."
          : plan.audience === "beginner"
            ? "- Follow-up: re-explain the previous answer for a beginner rather than adding new topics."
            : "- Follow-up: build on the earlier answers in this conversation; don't repeat what was already explained.",
    );
  }
  if (plan.comparison) lines.push("- Comparison: brief overview, the differences that matter for this question, then a conclusion on who or what each option suits.");
  if (plan.recommendation) lines.push("- Recommendation: reason from the trade-offs and say who each option suits; say what would change the recommendation (budget, use, priorities).");
  if (plan.parts.length) {
    lines.push(
      plan.parts.length >= 3
        ? "- Parts: the message asks several things. Answer EVERY part separately and in this order, each under its own short heading (###) or bold label; keep each section focused:"
        : "- Parts: the message asks two things. Address both explicitly and in this order (two short bold labels, or two clearly separated paragraphs):",
      ...plan.parts.map((p, i) => `  ${i + 1}. ${p.slice(0, 160)}`),
    );
  }
  return lines.join("\n");
}
