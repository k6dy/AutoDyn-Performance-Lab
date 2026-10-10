// Questions about AutoDyn itself ("Have you run the simulation yet?", "What do I click next?") are
// always in scope. Status and how-to questions are answered locally — no AI request — from the
// authoritative application state in the request context: the pending proposal, the applied
// configuration and the completed results are separate states and are reported separately.

import { splitParts } from "@/lib/ai/responsePlan";
import type { AssistantContext } from "@/lib/ai/schema";
import { extractTopic } from "@/lib/ai/topic";

/** Mentions of the application, its workflow or its outputs. */
const APP_WORDS =
  /\b(?:simulat\w*|proposals?|apply|applied|results?|analysis|analy[sz]e|feasib\w*|graphs?|charts?|plots?|curves?|reset|start over|new analysis|manual setup|specs|specifications|configuration|config|set-?up|pending|click|button|tab|export|autodyn|re-?run|recalculat\w*|up to date|out of date|stale|sensitivity|scenarios?|stock vs|saved analys\w*|save (?:this|it|the|my|an?)\b)/;

const norm = (s: string) => s.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();

export function isAppQuestion(text: string) {
  return APP_WORDS.test(norm(text)) || appQuestionKind(text) !== null;
}

type Kind = "ran" | "applied" | "pending" | "specs" | "next" | "current" | "feasibility" | "save" | "reset";

const KINDS: [Kind, RegExp][] = [
  ["next", /\bwhat (?:do|should|can) i (?:click|press|select|tap|do) (?:next|now)\b|\b(?:what(?:'s| is) the )?next step\b|\bwhat do i (?:click|press)\b|\bwhere do i click\b/],
  ["applied", /\b(?:is|was|has|have|did)\b[^?]*\b(?:proposal|changes?|it)\b[^?]*\bappl(?:y|ied)\b|\bappl(?:y|ied)\b[^?]*\b(?:yet|already)\b/],
  ["pending", /\b(?:what|which|any)\b[^?]*\b(?:changes?|proposals?)\b[^?]*\b(?:pending|proposed|waiting|queued|outstanding)\b|\bpending (?:changes?|proposals?)\b/],
  ["ran", /\b(?:have|has|did|was|were|is)\b[^?]*\b(?:run|ran|simulated|calculated|computed|analy[sz]ed|done|finished|completed?)\b[^?]*\b(?:simulation|analysis|it|that|results?|yet)\b|\b(?:simulation|analysis) (?:done|finished|complete|run)\b/],
  ["current", /\b(?:are|is)\b[^?]*\b(?:results?|numbers|analysis|figures)\b[^?]*\b(?:current|up to date|stale|out of date|latest|valid|outdated)\b/],
  ["specs", /\b(?:what|show|list|which)\b[^?]*\b(?:my|current|the current|loaded)\b[^?]*\b(?:specs|specifications|configuration|config|set-?up|inputs|vehicle)\b/],
  ["feasibility", /^(?:what(?:'s| is| was)|show(?: me)?|give me)\b[^?]*\bfeasibility\b/],
  ["save", /\bhow (?:do|can|would) i save\b|\bhow (?:is|are) (?:this|it|my|the) (?:analysis|results?|runs?) saved\b/],
  ["reset", /\bhow (?:do|can|would) i (?:reset|start over|clear|start fresh)\b|\breset (?:everything|all|the app)\b/],
];

export function appQuestionKind(text: string): Kind | null {
  const n = norm(text);
  return KINDS.find(([, re]) => re.test(n))?.[0] ?? null;
}

/** Asks AutoDyn to do something with a vehicle (identify, analyze, modify) rather than report state. */
const ACTION = /\b(?:analy[sz]e|propose|add|load|simulate|compare|modify|upgrade|swap|tune|remove|reduce|increase|lower)\b|\b\d+(?:\.\d+)?\s*(?:hp|horsepower|bhp|kw|ps|lb-?ft|lbs?|kg|nm|psi|%)\b/i;

/**
 * True only when the whole message is a state or how-to question. A status question bundled with
 * other requests ("Analyze a 2015 C300, propose +60 hp, and say whether it has run") must not be
 * answered locally on its own — the other intents still need processing.
 */
export function isPureAppQuestion(text: string) {
  if (!appQuestionKind(text) || splitParts(text).length >= 2 || ACTION.test(text)) return false;
  const t = extractTopic(text);
  return t.makes.length + t.models.length + t.ambiguous.length === 0;
}

/** The state-question part of a multipart message ("…and whether the simulation has run yet"), if any. */
export function appStatusPart(text: string): string | null {
  const parts = splitParts(text);
  return parts.length >= 2 ? (parts.find((p) => appQuestionKind(p) !== null && !ACTION.test(p)) ?? null) : null;
}

const PROVENANCE: Record<string, string> = { verified: "verified dataset", user: "user-provided", estimated: "estimated" };

function results(ctx: AssistantContext) {
  if (!ctx.results) return "none" as const;
  if (ctx.results.stale) return "stale" as const;
  return "current" as const;
}

function headline(ctx: AssistantContext) {
  const r = ctx.results;
  const row = r?.metrics.find((m) => /0[–-]60/.test(m.metric));
  if (!row) return "";
  return ` 0–60 mph: ${row.modified ? `${row.stock} stock → ${row.modified} modified` : row.stock}.`;
}

const pendingText = (ctx: AssistantContext) => {
  const p = ctx.pendingProposal;
  if (!p) return "";
  const what = [p.vehicle, ...p.changes].filter(Boolean).join(", ") || "the proposed configuration";
  return what;
};

function appliedText(ctx: AssistantContext) {
  const mods = ctx.modifiedChanges ?? [];
  return mods.length ? mods.map((m) => `${m.field} ${m.stock} → ${m.modified}`).join("; ") : "";
}

/** The exact next action in the AutoDyn workflow for the current state. */
export function nextAction(ctx: AssistantContext): string {
  const p = ctx.pendingProposal;
  if (p?.needsChoice) return "Choose the exact variant in the pending proposal, then select **Apply to Simulation**.";
  if (p) return "Review the pending proposal and select **Apply to Simulation** (or **Cancel**). Nothing runs until you apply it.";
  if (!ctx.vehicle) return "Choose a vehicle in **Manual Setup** (year, make, model, trim), or ask me to load one.";
  const r = results(ctx);
  if (r === "none") return "Select **Run analysis** in Manual Setup to simulate the current configuration.";
  if (r === "stale") return "Select **Re-run analysis** — the inputs changed since the last results.";
  if (ctx.results?.savedSnapshot && !ctx.results.savedSnapshot.engineCurrent) return "These are saved results from an earlier engine version; select **Recalculate using current engine** on Results to update them.";
  return "The results are current — open **Results** to review them, or describe a change to compare.";
}

/** Local answer for an application-state or how-to question, or null when it needs an explanation. */
export function appStateReply(text: string, ctx: AssistantContext): string | null {
  const kind = appQuestionKind(text);
  if (!kind) return null;
  const r = results(ctx);
  const vehicle = ctx.vehicle?.label;
  const pending = pendingText(ctx);
  const applied = appliedText(ctx);
  const snap = ctx.results?.savedSnapshot;

  switch (kind) {
    case "next":
      return nextAction(ctx);
    case "ran": {
      if (r === "none") return `No — nothing has been simulated yet.${pending ? ` The proposal (${pending}) is waiting for your approval; AutoDyn only runs after you apply it.` : ""} ${nextAction(ctx)}`;
      if (r === "stale") return `Not for the current inputs: the last results are out of date because the configuration changed. ${nextAction(ctx)}`;
      if (pending) return `Yes for the applied configuration${vehicle ? ` of the ${vehicle}` : ""}, but the pending proposal (${pending}) hasn't been applied or simulated.${headline(ctx)} ${nextAction(ctx)}`;
      return `Yes — AutoDyn's physics engine has results for the current configuration${vehicle ? ` of the ${vehicle}` : ""}.${headline(ctx)}${snap ? ` These are saved results from ${snap.savedAt.slice(0, 10)}.` : ""}`;
    }
    case "applied":
      if (pending) return `No — the proposal is still pending: ${pending}. ${nextAction(ctx)}`;
      return applied ? `There's no pending proposal. Applied modifications in the current configuration: ${applied}.` : "There's no pending proposal, and no modifications are applied — the configuration is stock.";
    case "pending":
      return `${pending ? `Pending (proposed, not applied or simulated): ${pending}.` : "Nothing is pending."}${applied ? ` Applied: ${applied}.` : ""}${pending ? ` ${nextAction(ctx)}` : ""}`;
    case "current":
      if (r === "none") return `There are no results yet — nothing has been simulated. ${nextAction(ctx)}`;
      if (r === "stale") return "No — inputs changed since the last analysis, so these results are out of date. Select **Re-run analysis** to recalculate.";
      if (snap) {
        return `These are saved results from ${snap.savedAt.slice(0, 10)}, shown as stored. They match the inputs they were saved with${snap.engineCurrent ? " and the current engine version" : ", but were calculated by an earlier engine version — select **Recalculate using current engine** to update them"}.${pending ? ` They don't include the pending proposal (${pending}).` : ""}`;
      }
      return pending ? `They're current for the applied configuration, but don't include the pending proposal (${pending}).` : "Yes — they were calculated for the current inputs.";
    case "specs": {
      if (!ctx.vehicle) return "No vehicle is loaded yet. Choose one in **Manual Setup**, or ask me to load one.";
      const set = ctx.stockSpecs.filter((s) => s.provenance !== "unavailable").slice(0, 14);
      const missing = ctx.stockSpecs.length - set.length;
      const lines = set.map((s) => `- ${s.field}: ${s.value} (${PROVENANCE[s.provenance] ?? s.provenance})`);
      return [
        `**${ctx.vehicle.label}** — source: ${ctx.vehicle.sourceDetail}.`,
        ...lines,
        missing > 0 ? `- ${missing} more field${missing === 1 ? "" : "s"} not set (AutoDyn uses documented defaults or estimates).` : "",
        applied ? `\nApplied modifications: ${applied}.` : "",
        pending ? `\nPending (not applied): ${pending}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "feasibility": {
      if (!ctx.results) return `There's no feasibility assessment yet — AutoDyn's deterministic engine produces it when an analysis runs. ${nextAction(ctx)}`;
      const lines = (ctx.results.feasibility ?? []).filter((l) => /^(?:Stock|Modified) feasibility:/.test(l));
      if (!lines.length) return null;
      return `${lines.map((l) => `- ${l}`).join("\n")}${ctx.results.stale ? "\n\nThese are from the last run; inputs have changed since — re-run to update them." : ""}`;
    }
    case "save":
      return `Each completed run is saved automatically to **Saved Analyses** (re-running updates the same entry; use **Duplicate** there to keep a copy). Conversations are saved automatically in Chat history.${r === "none" ? " Nothing has been run yet, so there's nothing to save — select **Run analysis** first." : ""}`;
    case "reset":
      return "Select **New Analysis** to clear the workspace (vehicle, changes and results); Saved Analyses, chats and your unit choice are kept. To remove saved analyses use **Delete all** in Saved Analyses; to remove chats use **Clear all chats** in Chat history.";
  }
}
