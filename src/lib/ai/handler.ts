// Assistant request pipeline with injected dependencies so it can be tested without a network,
// an API key or a real model. The route handler wires in the real Gemini caller and limiter.

import { buildContents } from "@/lib/ai/prompt";
import { buildChanges, cleanReply, clipText, completedPart, holdChanges, salvageReply, sanitizeReply, unverifiedFigures } from "@/lib/ai/proposal";
import { modelOutputSchema, requestSchema, type AssistantRequest, type ModelOutput } from "@/lib/ai/schema";
import type { AssistantErrorCode, AssistantResponse, Proposal, SuggestedAction, VehicleProposal } from "@/lib/ai/types";
import { AI_LIMITS, PROVIDER_MESSAGES, SHORTENED_NOTICE } from "@/lib/ai/types";
import { applyProposal } from "@/lib/ai/apply";
import { appStateReply, appStatusPart, isPureAppQuestion } from "@/lib/ai/appState";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { gatherGrounding, lookupTargets, sourcesOf, type OwnershipSources } from "@/lib/ai/grounding";
import { contradictsKnownSpecs, specFacts, specsKnown, vehicleFacts } from "@/lib/ai/vehicleData";
import { dropEmptySections, filterSentences, stripFalseAttribution, stripStatusClaims, stripUnbackedPerformance, stripUnmodeledClaims, stripUnverifiedMoney } from "@/lib/ai/guards";
import { classifyRelevance, declineNote, isInjection, localReply } from "@/lib/ai/relevance";
import { OUTPUT_BUDGET, planResponse } from "@/lib/ai/responsePlan";
import { describeTopic } from "@/lib/ai/topic";
import { candidateLabel, matchVehicle, type VehicleQuery } from "@/lib/vehicles/match";
import { datasetTrimToSpecSet, identityOnlySpecSet, trimLabel, vehicleLabel, type DatasetTrim } from "@/lib/vehicles/normalize";
import type { LimitDecision } from "@/lib/ai/rateLimit.server";
import type { SpecSet } from "@/lib/domain/types";
import type { ModelCallResult } from "@/lib/ai/gemini.server";

export type AssistantDeps = {
  configured: boolean;
  timeoutMs: number;
  /** maxOutputTokens: the budget for this request's answer depth (the provider applies its own ceiling). */
  callModel: (contents: unknown[], signal: AbortSignal, opts?: { maxOutputTokens?: number }) => Promise<ModelCallResult>;
  limiter: { check(key: string): Promise<LimitDecision>; claim(id: string): Promise<boolean> };
  clientKey: string;
  trims: () => DatasetTrim[];
  /** Builds a spec set for a matched trim (server attaches weight estimates). */
  specSetFor?: (trim: DatasetTrim) => SpecSet;
  nhtsaModels: (make: string, year: number) => Promise<string[]>;
  /** Official free ownership data (EPA ratings and U.S. variant lists, NHTSA recalls). Optional:
   *  without it the assistant answers from general knowledge and says verified figures weren't available. */
  ownership?: OwnershipSources;
};

type Result = { status: number; body: AssistantResponse };

const STATUS: Record<AssistantErrorCode, number> = {
  not_configured: 503,
  invalid_key: 503,
  key_restricted: 503,
  model_unavailable: 503,
  model_unsupported: 503,
  provider_rate_limited: 429,
  internal_error: 500,
  request_rejected: 502,
  quota: 429,
  rate_limited: 429,
  timeout: 504,
  network: 502,
  server_error: 502,
  invalid_output: 502,
  invalid_request: 400,
  message_too_long: 413,
  duplicate: 409,
  offline: 503,
};

function fail(code: AssistantErrorCode, requestId?: string, retryAfterS?: number): Result {
  return { status: STATUS[code], body: { ok: false, code, message: PROVIDER_MESSAGES[code], requestId, retryAfterS } };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function resolveVehicle(q: VehicleQuery, deps: AssistantDeps): Promise<{ proposal: VehicleProposal | null; question: string | null }> {
  const label = [q.year, q.make, q.model, q.trim].filter(Boolean).join(" ");
  if (!q.make || !q.model) return { proposal: null, question: "Which vehicle do you mean? Please include the year, make and model." };
  const match = matchVehicle(deps.trims(), q);
  if (match.status === "unique") {
    const specSet = deps.specSetFor ? deps.specSetFor(match.trim) : datasetTrimToSpecSet(match.trim);
    return {
      proposal: {
        kind: "load",
        label: vehicleLabel(specSet.identity),
        specSet,
        note: `Matched ${trimLabel(match.trim)} in the specification dataset.${match.sharedWith ? ` ${match.sharedWith} other trim${match.sharedWith > 1 ? "s share" : " shares"} the same powertrain, drivetrain and weight.` : ""}`,
      },
      question: null,
    };
  }
  if (match.status === "multiple") {
    if (!match.candidates.length) return { proposal: null, question: match.question };
    return {
      proposal: {
        kind: "choose",
        label,
        make: match.candidates[0].make,
        note: match.question,
        candidates: match.candidates.map((t: DatasetTrim) => ({ trimId: t.id, label: `${candidateLabel(t)} · ${t.hp ?? "?"} hp · ${t.drive ?? "drive n/a"}` })),
      },
      question: match.question,
    };
  }
  // Not in the dataset — try NHTSA for identification only.
  if (q.year && q.year >= 1981) {
    try {
      const models = await deps.nhtsaModels(q.make, q.year);
      const hit = models.find((m) => norm(m) === norm(q.model!)) ?? models.find((m) => norm(q.model!).startsWith(norm(m)) && norm(m).length >= 2);
      if (hit) {
        const specSet = identityOnlySpecSet({
          year: q.year,
          make: q.make,
          model: hit,
          trim: q.trim ?? null,
          source: "nhtsa",
          sourceDetail: "NHTSA vPIC (identification only)",
          notes: ["NHTSA confirms this model exists but does not provide performance specifications. Enter power and curb weight to simulate."],
        });
        return {
          proposal: {
            kind: "identify",
            label: vehicleLabel(specSet.identity),
            specSet,
            note: `NHTSA confirms the ${q.year} ${q.make} ${hit} exists, but AutoDyn has no verified performance data for it. Missing: peak power and curb weight (required), torque (optional). Enter them in Manual Setup to analyze it.`,
          },
          question: null,
        };
      }
    } catch {
      // Provider failure falls through to not_found with an honest note.
    }
  }
  return {
    proposal: {
      kind: "not_found",
      label,
      note: `${match.reason} AutoDyn can still analyze it as a custom vehicle — you'll need its peak power and curb weight (torque optional).`,
    },
    question: null,
  };
}

const STATUS_WORDS: [RegExp, string][] = [
  [/non[- ]?feasible|infeasible|not feasible|conflicts with modeled constraints/i, "non_feasible"],
  [/insufficient data/i, "insufficient_data"],
  [/questionable|requires further verification/i, "questionable"],
  [/(?<!non[- ]?)\bfeasible within modeled constraints\b|(?<![-\w])feasible(?![-\w])/i, "feasible"],
];

function statusesIn(text: string) {
  const out = new Set<string>();
  let rest = text;
  for (const [re, s] of STATUS_WORDS) {
    if (re.test(rest)) {
      out.add(s);
      rest = rest.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  return out;
}

/** True when a sentence attributes a feasibility status to a scenario that the engine did not assign. */
export function contradictsFeasibility(reply: string, lines: string[]) {
  const engine: Record<string, string> = {};
  for (const l of lines) {
    const m = l.match(/^(Stock|Modified) feasibility: ([^.]+)\./);
    if (m) engine[m[1].toLowerCase()] = [...statusesIn(m[2])][0] ?? "";
  }
  const all = new Set(Object.values(engine));
  return reply.split(/(?<=[.!?;])\s+/).some((sentence) => {
    const claimed = statusesIn(sentence);
    if (!claimed.size) return false;
    const mod = /modif/i.test(sentence);
    const stock = /\bstock\b|factory/i.test(sentence);
    const allowed = mod && !stock && engine.modified ? new Set([engine.modified]) : stock && !mod && engine.stock ? new Set([engine.stock]) : all;
    return [...claimed].some((c) => !allowed.has(c));
  });
}

/** Shape of a reply recovered from cut-off output: plain conversation, no vehicle, no changes. */
const SALVAGED: ModelOutput = {
  intent: "general",
  reply: "",
  vehicle: { mentioned: false, year: null, make: null, model: null, trim: null },
  useCurrentVehicle: false,
  changes: [],
  view: "none",
  runSimulation: false,
  followUpQuestion: null,
};

const ANALYSIS_INTENTS = ["analyze_vehicle", "modify", "compare", "sensitivity", "explain", "assumptions"];

/**
 * Pipeline: validate → duplicate / rate-limit checks → local automotive relevance gate →
 * provider call → output validation. The gate is authoritative here (not only in the browser), so
 * direct API calls can't spend provider quota on off-topic requests.
 */
export async function handleAssistantRequest(raw: unknown, deps: AssistantDeps): Promise<Result> {
  const maybe = raw as { message?: unknown; requestId?: unknown } | null;
  const requestId = typeof maybe?.requestId === "string" ? maybe.requestId.slice(0, 64) : undefined;
  if (typeof maybe?.message === "string" && maybe.message.trim().length > AI_LIMITS.maxMessageChars) return fail("message_too_long", requestId);

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_request", requestId);
  const req: AssistantRequest = parsed.data;
  if (JSON.stringify(req.context).length > AI_LIMITS.maxContextChars) return fail("invalid_request", req.requestId);

  if (!(await deps.limiter.claim(req.requestId))) return fail("duplicate", req.requestId);
  const limit = await deps.limiter.check(deps.clientKey);
  if (!limit.allowed) return fail(limit.scope === "global" ? "quota" : "rate_limited", req.requestId, limit.retryAfterS);

  // Client history is untrusted: roles are schema-checked; entries that try to act as instructions
  // (role labels, "ignore your rules"…) are dropped before classification and before the provider.
  const history = req.history.filter((h) => !isInjection(h.text));
  const relevance = classifyRelevance(req.message, { history, hasVehicle: !!req.context.vehicle, hasResults: !!req.context.results });
  if (relevance.decision !== "allow") {
    return {
      status: 200,
      body: {
        ok: true,
        requestId: req.requestId,
        reply: localReply(relevance)!,
        followUpQuestion: null,
        proposal: null,
        suggestedAction: null,
        notices: [],
        local: relevance.decision === "reject" ? (relevance.basis === "injection" ? "injection" : "off_topic") : relevance.decision === "clarify" ? "clarify" : "small_talk",
      },
    };
  }
  // Questions about AutoDyn's own state ("Have you run it yet?") are answered from the request's
  // application state — authoritative, and without a provider call.
  // Only a message that is purely a state question is answered here; bundled with other requests,
  // the status part is reported alongside the provider's answer below.
  const appMessage = relevance.supported ?? req.message;
  const appReply = isPureAppQuestion(appMessage) ? appStateReply(appMessage, req.context) : null;
  if (appReply) {
    const reply = relevance.declined?.length ? `${appReply}\n\n${declineNote(relevance.declined)}` : appReply;
    return { status: 200, body: { ok: true, requestId: req.requestId, reply, followUpQuestion: null, proposal: null, suggestedAction: null, notices: [], local: "app_state" } };
  }
  if (!deps.configured) return fail("not_configured", req.requestId);
  // How deep and in what shape to answer is decided locally and sent with the one provider request.
  // Follow-ups include clearly automotive messages that build on the current subject ("Which ones are supercharged?").
  const isFollowUp = relevance.continues || relevance.outcome === "CONTEXTUAL_FOLLOWUP";
  // Mixed messages: only the automotive portion reaches the provider; the rest is declined locally.
  const message = relevance.supported ?? req.message;
  const plan = planResponse(message, { detail: req.detail, followUp: isFollowUp });
  const userTexts = [...history.filter((h) => h.role === "user").map((h) => h.text), message];
  const external = await gatherGrounding({ aspect: relevance.aspect, topic: relevance.topic, context: req.context, message, userTexts, sources: deps.ownership });
  // Vehicles named in the message are resolved against the dataset BEFORE the provider answers, with
  // the same matcher the proposal uses — so the reply and Review Changes describe the same records.
  const facts = vehicleFacts(lookupTargets(relevance.topic, req.context, message, userTexts), {
    trims: deps.trims(),
    message,
    units: req.context.units,
    loaded: req.context.vehicle,
    specSetFor: deps.specSetFor,
  });
  // A state question bundled with other requests: AutoDyn answers that part from the real state.
  const statusPart = appStatusPart(message);
  const statusNow = statusPart ? appStateReply(statusPart, req.context) : null;
  const hints = {
    subject: describeTopic(relevance.topic),
    followUp: isFollowUp,
    plan,
    aspect: relevance.aspect,
    comparing: !!relevance.topic?.comparing,
    external,
    appState: statusNow,
    vehicleData: facts,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  let call: ModelCallResult;
  try {
    call = await Promise.race([
      deps.callModel(buildContents({ ...req, message, history }, hints), controller.signal, { maxOutputTokens: OUTPUT_BUDGET[plan.depth] }),
      new Promise<ModelCallResult>((resolve) => controller.signal.addEventListener("abort", () => resolve({ ok: false, code: "timeout" }))),
    ]);
  } catch {
    call = { ok: false, code: "internal_error" };
  } finally {
    clearTimeout(timer);
  }
  if (!call.ok) return fail(call.code, req.requestId);

  let output: ModelOutput | null = null;
  try {
    const out = modelOutputSchema.safeParse(JSON.parse(call.text));
    if (out.success) output = out.data;
  } catch {
    output = null;
  }
  // An answer cut off at the output limit keeps its completed part — as conversation only, never a
  // proposal. Anything else that fails validation is discarded.
  let shortened = false;
  if (!output) {
    const partial = call.truncated ? salvageReply(call.text) : null;
    const text = partial ? completedPart(partial) : "";
    if (text.length < 40) return fail("invalid_output", req.requestId);
    shortened = true;
    output = { ...SALVAGED, reply: text };
  }

  let followUp = output.followUpQuestion ? sanitizeReply(output.followUpQuestion).slice(0, 300) : null;
  let vehicle: VehicleProposal | null = null;
  // Ordinary automotive conversation never produces a simulation proposal.
  if (output.intent === "general") output.changes = [];
  if (output.vehicle.mentioned && !output.useCurrentVehicle && output.intent !== "general") {
    const r = await resolveVehicle(output.vehicle, deps);
    vehicle = r.proposal;
    followUp = followUp ?? r.question;
  }

  const { changes, rejected } = buildChanges(output, req.message);
  // "…but keep peak torque at 273 lb-ft": an explicit constraint AutoDyn enforces even if the model omitted it.
  changes.push(...holdChanges(req.message, changes));
  const hasVehicle = !!req.context.vehicle || vehicle?.kind === "load" || vehicle?.kind === "identify";
  const vehicleChanges = changes.filter((c) => c.target !== "conditions");
  if (!hasVehicle && vehicleChanges.length) {
    for (const c of vehicleChanges) rejected.push({ text: `${c.key}: ${c.display}`, reason: "Choose a vehicle before proposing changes." });
  }
  const kept = hasVehicle ? changes : changes.filter((c) => c.target === "conditions");

  const proposal: Proposal | null =
    vehicle || kept.length || rejected.length
      ? {
          id: `p-${req.requestId}`,
          intent: output.intent,
          vehicle,
          changes: kept,
          rejected,
          view: output.view === "none" ? null : output.view,
          runAfterApply: output.runSimulation,
        }
      : null;

  let suggestedAction: SuggestedAction = null;
  if (!proposal && req.context.vehicle && ANALYSIS_INTENTS.includes(output.intent)) {
    if (!req.context.results || req.context.results.stale) suggestedAction = "run_analysis";
    else if (["explain", "sensitivity", "assumptions", "compare", "analyze_vehicle"].includes(output.intent)) suggestedAction = "open_results";
  }

  const clipped = clipText(cleanReply(output.reply), AI_LIMITS.maxReplyChars);
  let reply = clipped.text || (followUp ?? "I couldn't produce an answer for that. Try rephrasing, or use Manual Setup.");
  const notices: string[] = [];
  if (shortened || clipped.clipped) notices.push(SHORTENED_NOTICE);
  // Everything AutoDyn or the user supplied: figures found here are not "invented".
  const known = `${JSON.stringify(req.context)} ${req.message} ${req.history.map((h) => h.text).join(" ")} ${
    vehicle && "specSet" in vehicle ? JSON.stringify(vehicle.specSet) : ""
  } ${vehicle && "specSet" in vehicle ? JSON.stringify(specFacts(vehicle.specSet, req.context.units)) : ""} ${JSON.stringify(facts)} ${kept.map((c) => c.display).join(" ")} ${JSON.stringify(external)}`;

  // Simulation state: performance claims need current physics results. A proposal (new or still
  // pending) means nothing has been simulated for it yet.
  const pending = proposal ?? (req.context.pendingProposal ? true : null);
  const resultsCurrent = !!req.context.results && !req.context.results.stale && !pending;
  if (!resultsCurrent && (pending || output.intent !== "general" || /\b(?:simulat|result)/i.test(reply))) {
    const g = stripUnbackedPerformance(reply, known, { figures: !!pending || output.intent !== "general" });
    if (g.removed) reply = g.text || "Nothing has been simulated yet, so there are no calculated results to report.";
  }
  // AutoDyn states the simulation status itself (status line or next-step notice), so the model's own
  // status sentences would only repeat it.
  if (proposal || statusPart) {
    const st = stripStatusClaims(reply);
    if (st.removed) reply = st.text;
  }
  if (proposal && !statusPart) notices.push(nextStep(proposal));
  else if (!statusPart && req.context.pendingProposal && ANALYSIS_INTENTS.includes(output.intent)) {
    notices.push(req.context.pendingProposal.needsChoice ? "Not simulated yet: choose the exact variant in the pending proposal, then select Apply to Simulation." : "Not simulated yet: the proposal above is still waiting — select Apply to Simulation (or Cancel) to continue.");
  }
  // Dollar figures (market prices, insurance, repairs, fuel costs) only from data AutoDyn or the user supplied.
  const money = stripUnverifiedMoney(reply, known);
  if (money.removed) {
    reply = money.text || "AutoDyn has no verified pricing for this, so it won't quote a figure.";
    notices.push("Unverified dollar amounts were left out — AutoDyn has no live market, insurance or repair-price data.");
  }
  // Never contradict the dataset: when AutoDyn has the power, torque and weight (named vehicle, proposal
  // vehicle or the loaded one), sentences claiming they are missing are removed.
  const loadedKnown = !facts.length && ["Peak power", "Peak torque", "Vehicle weight (curb)"].every((f) => req.context.stockSpecs.some((x) => x.field === f && x.provenance !== "unavailable"));
  if (loadedKnown || specsKnown(facts, vehicle?.kind === "load" ? vehicle.specSet : null)) {
    const c = filterSentences(reply, contradictsKnownSpecs);
    if (c.removed) reply = c.text || "AutoDyn's dataset has this vehicle's power, torque and curb weight — see the proposal below.";
  }
  // A specification credited to a verified source (EPA, "verified", "official") must be in AutoDyn's data.
  const attribution = stripFalseAttribution(reply, known);
  if (attribution.removed) {
    reply = attribution.text || "AutoDyn doesn't have a verified source for that specification.";
    notices.push("A specification credited to a verified source wasn't in AutoDyn's data and was left out. EPA data covers fuel economy, not horsepower or torque.");
  }
  // The feasibility engine doesn't model cooling, thermal stress or component tolerances.
  const unmodeled = stripUnmodeledClaims(reply);
  if (unmodeled.removed) {
    reply = unmodeled.text || "AutoDyn's feasibility engine doesn't model that.";
    notices.push("AutoDyn's simulation doesn't model cooling, thermal stress or stock component tolerances — treat those as unverified mechanical considerations.");
  }
  const figures = unverifiedFigures(reply, known).filter((f) => !f.includes("$"));
  if (figures.length) notices.push(`Not verified by AutoDyn (general knowledge): ${figures.join(", ")}.`);
  // Headings left empty by the guards (before AutoDyn appends its own lines below them).
  reply = dropEmptySections(reply);
  // The status part is reported by AutoDyn itself: a proposal made now has not been simulated.
  if (statusPart) {
    const status = proposal ? nextStep(proposal).replace(/^Not simulated yet: (\w)/, (_, c: string) => `No — nothing has been simulated yet. ${c.toUpperCase()}`) : statusNow;
    if (status) reply = `${reply}\n\n**Simulation status:** ${status}`.trim();
  }
  if (relevance.declined?.length) reply = `${reply}\n\n${declineNote(relevance.declined)}`;
  // Headings whose content was removed above ("### Expected Changes" with nothing under it) are dropped.
  reply = dropEmptySections(reply) || (proposal ? "The proposal is ready for your review below." : "I couldn't produce an answer for that. Try rephrasing, or use Manual Setup.");
  const feasibilityLines = req.context.results?.feasibility ?? [];
  if (feasibilityLines.length && contradictsFeasibility(reply, feasibilityLines)) {
    notices.push(
      `AutoDyn's deterministic feasibility assessment is authoritative: ${feasibilityLines
        .filter((l) => /feasibility:/.test(l))
        .map((l) => l.split(". ")[0])
        .join("; ")}.`,
    );
  }
  if (req.context.results?.stale && ["explain", "sensitivity", "assumptions"].includes(output.intent)) {
    notices.push("Inputs changed since the last analysis, so the explanation may not match the current configuration. Re-run the analysis.");
  }

  return {
    status: 200,
    body: { ok: true, requestId: req.requestId, reply, followUpQuestion: followUp, proposal, suggestedAction, notices, sources: sourcesOf(external) },
  };
}

/** The exact next action for a new proposal — nothing is simulated until the user applies it. */
function nextStep(p: Proposal) {
  const v = p.vehicle;
  if (v?.kind === "choose") return "Not simulated yet: choose the exact variant below, then select Apply to Simulation.";
  if (v?.kind === "identify" || v?.kind === "not_found") return "Not simulated yet: AutoDyn needs the missing specifications listed below before it can run.";
  if (!p.changes.length && !v) return "Not simulated yet: nothing in this request can be applied — see the notes below.";
  const check = deterministicCheck(p);
  if (check?.conflict) return `Not simulated yet: ${check.conflict.replace(/\.$/, "")}. Choose an option in the proposal below or adjust the values (or cancel), then select Apply to Simulation.`;
  if (check?.error) return `Not simulated yet: AutoDyn's input validation blocks these values — ${check.error.replace(/\.$/, "")}. Adjust them in the proposal below (or cancel), then select Apply to Simulation.`;
  const modeled = check?.derived ? ` AutoDyn added an estimated ${check.derived} so power and torque stay consistent; it's labeled in the proposal.` : "";
  return `Not simulated yet: review the proposed changes below and select Apply to Simulation to run the physics engine.${modeled}`;
}

/**
 * The same deterministic preparation and validation the review panel applies, for a proposal that
 * brings its own vehicle — so the next step names a real blocker or the values AutoDyn modeled.
 */
function deterministicCheck(p: Proposal): { error: string | null; conflict: string | null; derived: string | null } | null {
  if (p.vehicle?.kind !== "load") return null;
  const empty = { stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } };
  const { config, curve } = applyProposal(empty, p, { selected: Object.fromEntries(p.changes.map((c) => [c.id, true])) });
  const derived = curve?.derived.some((d) => d.key === "peakTorqueNm") ? "torque curve" : curve?.derived.some((d) => d.key === "peakPowerKw") ? "peak power" : null;
  return {
    error: validateConfig(config).issues.find((i) => i.severity === "error")?.message ?? null,
    conflict: curve?.status === "conflict" ? curve.conflict : null,
    derived,
  };
}
