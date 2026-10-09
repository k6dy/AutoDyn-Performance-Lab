// Assistant request pipeline with injected dependencies so it can be tested without a network,
// an API key or a real model. The route handler wires in the real Gemini caller and limiter.

import { buildContents } from "@/lib/ai/prompt";
import { buildChanges, sanitizeReply, unverifiedFigures } from "@/lib/ai/proposal";
import { modelOutputSchema, requestSchema, type AssistantRequest } from "@/lib/ai/schema";
import type { AssistantErrorCode, AssistantResponse, Proposal, SuggestedAction, VehicleProposal } from "@/lib/ai/types";
import { AI_LIMITS, PROVIDER_MESSAGES } from "@/lib/ai/types";
import { candidateLabel, matchVehicle, type VehicleQuery } from "@/lib/vehicles/match";
import { datasetTrimToSpecSet, identityOnlySpecSet, trimLabel, vehicleLabel, type DatasetTrim } from "@/lib/vehicles/normalize";
import type { LimitDecision } from "@/lib/ai/rateLimit.server";
import type { SpecSet } from "@/lib/domain/types";
import type { ModelCallResult } from "@/lib/ai/gemini.server";

export type AssistantDeps = {
  configured: boolean;
  timeoutMs: number;
  callModel: (contents: unknown[], signal: AbortSignal) => Promise<ModelCallResult>;
  limiter: { check(key: string): Promise<LimitDecision>; claim(id: string): Promise<boolean> };
  clientKey: string;
  trims: () => DatasetTrim[];
  /** Builds a spec set for a matched trim (server attaches weight estimates). */
  specSetFor?: (trim: DatasetTrim) => SpecSet;
  nhtsaModels: (make: string, year: number) => Promise<string[]>;
};

type Result = { status: number; body: AssistantResponse };

const STATUS: Record<AssistantErrorCode, number> = {
  not_configured: 503,
  invalid_key: 503,
  model_unavailable: 503,
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

export async function handleAssistantRequest(raw: unknown, deps: AssistantDeps): Promise<Result> {
  const maybe = raw as { message?: unknown; requestId?: unknown } | null;
  const requestId = typeof maybe?.requestId === "string" ? maybe.requestId.slice(0, 64) : undefined;
  if (typeof maybe?.message === "string" && maybe.message.trim().length > AI_LIMITS.maxMessageChars) return fail("message_too_long", requestId);

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return fail("invalid_request", requestId);
  const req: AssistantRequest = parsed.data;
  if (JSON.stringify(req.context).length > AI_LIMITS.maxContextChars) return fail("invalid_request", req.requestId);

  if (!deps.configured) return fail("not_configured", req.requestId);
  if (!(await deps.limiter.claim(req.requestId))) return fail("duplicate", req.requestId);
  const limit = await deps.limiter.check(deps.clientKey);
  if (!limit.allowed) return fail(limit.scope === "global" ? "quota" : "rate_limited", req.requestId, limit.retryAfterS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  let call: ModelCallResult;
  try {
    call = await Promise.race([
      deps.callModel(buildContents(req), controller.signal),
      new Promise<ModelCallResult>((resolve) => controller.signal.addEventListener("abort", () => resolve({ ok: false, code: "timeout" }))),
    ]);
  } catch {
    call = { ok: false, code: "server_error" };
  } finally {
    clearTimeout(timer);
  }
  if (!call.ok) return fail(call.code, req.requestId);

  let json: unknown;
  try {
    json = JSON.parse(call.text);
  } catch {
    return fail("invalid_output", req.requestId);
  }
  const out = modelOutputSchema.safeParse(json);
  if (!out.success) return fail("invalid_output", req.requestId);
  const output = out.data;

  let followUp = output.followUpQuestion ? sanitizeReply(output.followUpQuestion).slice(0, 300) : null;
  let vehicle: VehicleProposal | null = null;
  if (output.vehicle.mentioned && !output.useCurrentVehicle) {
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
  if (!proposal && req.context.vehicle) {
    if (!req.context.results || req.context.results.stale) suggestedAction = "run_analysis";
    else if (["explain", "sensitivity", "assumptions", "compare", "analyze_vehicle"].includes(output.intent)) suggestedAction = "open_results";
  }

  const reply = sanitizeReply(output.reply) || (followUp ?? "I couldn't produce an answer for that. Try rephrasing, or use Manual Setup.");
  const notices: string[] = [];
  const known = `${JSON.stringify(req.context)} ${req.message} ${req.history.map((h) => h.text).join(" ")} ${
    vehicle && "specSet" in vehicle ? JSON.stringify(vehicle.specSet) : ""
  } ${kept.map((c) => c.display).join(" ")}`;
  const unverified = unverifiedFigures(reply, known);
  if (unverified.length) {
    notices.push(`This reply mentions figures that are not in AutoDyn's data for this session (${unverified.join(", ")}). Treat them as unverified.`);
  }
  if (req.context.results?.stale && ["explain", "sensitivity", "assumptions"].includes(output.intent)) {
    notices.push("Inputs changed since the last analysis, so the explanation may not match the current configuration. Re-run the analysis.");
  }

  return {
    status: 200,
    body: { ok: true, requestId: req.requestId, reply, followUpQuestion: followUp, proposal, suggestedAction, notices },
  };
}
