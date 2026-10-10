// Assistant request pipeline with injected dependencies so it can be tested without a network,
// an API key or a real model. The route handler wires in the real Gemini caller and limiter.

import { buildContents } from "@/lib/ai/prompt";
import { buildChanges, cleanReply, clipText, completedPart, salvageReply, sanitizeReply, unverifiedFigures } from "@/lib/ai/proposal";
import { modelOutputSchema, requestSchema, type AssistantRequest, type ModelOutput } from "@/lib/ai/schema";
import type { AssistantErrorCode, AssistantResponse, Proposal, SuggestedAction, VehicleProposal } from "@/lib/ai/types";
import { AI_LIMITS, PROVIDER_MESSAGES, SHORTENED_NOTICE } from "@/lib/ai/types";
import { gatherGrounding, sourcesOf, type OwnershipSources } from "@/lib/ai/grounding";
import { stripUnbackedPerformance, stripUnverifiedMoney } from "@/lib/ai/guards";
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
  if (!deps.configured) return fail("not_configured", req.requestId);
  // How deep and in what shape to answer is decided locally and sent with the one provider request.
  // Follow-ups include clearly automotive messages that build on the current subject ("Which ones are supercharged?").
  const isFollowUp = relevance.continues || relevance.outcome === "CONTEXTUAL_FOLLOWUP";
  // Mixed messages: only the automotive portion reaches the provider; the rest is declined locally.
  const message = relevance.supported ?? req.message;
  const plan = planResponse(message, { detail: req.detail, followUp: isFollowUp });
  const userTexts = [...history.filter((h) => h.role === "user").map((h) => h.text), message];
  const external = await gatherGrounding({ aspect: relevance.aspect, topic: relevance.topic, context: req.context, message, userTexts, sources: deps.ownership });
  const hints = {
    subject: describeTopic(relevance.topic),
    followUp: isFollowUp,
    plan,
    aspect: relevance.aspect,
    comparing: !!relevance.topic?.comparing,
    external,
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
  } ${kept.map((c) => c.display).join(" ")} ${JSON.stringify(external)}`;

  // Simulation state: performance claims need current physics results. A proposal (new or still
  // pending) means nothing has been simulated for it yet.
  const pending = proposal ?? (req.context.pendingProposal ? true : null);
  const resultsCurrent = !!req.context.results && !req.context.results.stale && !pending;
  if (!resultsCurrent && (pending || output.intent !== "general" || /\b(?:simulat|result)/i.test(reply))) {
    const g = stripUnbackedPerformance(reply, known, { figures: !!pending || output.intent !== "general" });
    if (g.removed) reply = g.text || "Nothing has been simulated yet, so there are no calculated results to report.";
  }
  if (proposal) notices.push(nextStep(proposal));
  else if (req.context.pendingProposal && ANALYSIS_INTENTS.includes(output.intent)) {
    notices.push(req.context.pendingProposal.needsChoice ? "Not simulated yet: choose the exact variant in the pending proposal, then select Apply to Simulation." : "Not simulated yet: the proposal above is still waiting — select Apply to Simulation (or Cancel) to continue.");
  }
  // Dollar figures (market prices, insurance, repairs, fuel costs) only from data AutoDyn or the user supplied.
  const money = stripUnverifiedMoney(reply, known);
  if (money.removed) {
    reply = money.text || "AutoDyn has no verified pricing for this, so it won't quote a figure.";
    notices.push("Unverified dollar amounts were left out — AutoDyn has no live market, insurance or repair-price data.");
  }
  const figures = unverifiedFigures(reply, known).filter((f) => !f.includes("$"));
  if (figures.length) notices.push(`Not verified by AutoDyn (general knowledge): ${figures.join(", ")}.`);
  if (relevance.declined?.length) reply = `${reply}\n\n${declineNote(relevance.declined)}`;
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
  return "Not simulated yet: review the proposed changes below and select Apply to Simulation to run the physics engine.";
}
