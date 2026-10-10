// Application state. Pure reducer so behavior (mode switching, staleness, confirmation-gated AI
// changes) is unit-testable without rendering.

import type { AssistantErrorCode, Proposal, SuggestedAction } from "@/lib/ai/types";
import { resultsSummary } from "@/lib/analysis/summary";
import { setModifiedValue, setStockValue } from "@/lib/domain/scenario";
import type { AnalysisConfig, Conditions, ConstraintKey, ScenarioId, SpecKey, SpecSet, SpecValues } from "@/lib/domain/types";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { toActive, type ActiveSaved } from "@/lib/persistence/autosave";
import type { DraftOffer } from "@/lib/persistence/draft";
import type { SavedAnalysis } from "@/lib/persistence/schema";
import { fingerprint, isHistorical } from "@/lib/persistence/snapshot";
import type { AnalysisResult } from "@/lib/physics/analysis";
import type { UnitSystem } from "@/lib/units";

export type Mode = "manual" | "assistant" | "results" | "saved";
export type ResultsView = "stock" | "modified" | "compare";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  proposalId?: string;
  notices?: string[];
  errorCode?: AssistantErrorCode;
  followUp?: string | null;
  suggestedAction?: SuggestedAction;
  /** Deterministic results summary posted after an assistant-applied run. */
  kind?: "results";
};

export type ProposalState = {
  proposal: Proposal;
  status: "pending" | "applied" | "cancelled" | "superseded";
  selected: Record<string, boolean>;
  edits: Record<string, number | string>;
  chosen: SpecSet | null;
};

export type SavedState = {
  /** Saved analysis the workspace is linked to (re-runs update it; see persistence/autosave). */
  active: ActiveSaved | null;
  /** Set while the displayed result is a stored snapshot rather than computed in this session. */
  snapshot: { id: string; engineVersion: string; createdAt: string; updatedAt: string; imported: boolean; verified: boolean | null } | null;
  /** A historical snapshot this run recalculated; its original stays untouched unless replaced. */
  recalculatedFrom: { id: string; title: string; engineVersion: string } | null;
  status: "idle" | "saving" | "saved" | "error";
  error: string | null;
  /** Bumped whenever saved records change, so list views reload. */
  listRevision: number;
};

export type AppState = {
  config: AnalysisConfig;
  /** Vehicle exactly as loaded from its provider; used for per-field and full resets. */
  baseline: SpecSet | null;
  revision: number;
  result: { analysis: AnalysisResult; revision: number; origin: "run" | "saved" } | null;
  /** Revision a run was requested for; the provider computes it after the state commits. */
  runRequest: { revision: number; navigate: boolean; source: "manual" | "assistant" | "recalc" } | null;
  /** Last session's workspace, offered (not applied) on return. */
  draftOffer: DraftOffer | null;
  /** Saved values that were physically invalid and were reset when a session was continued. */
  restoredFixes: string[];
  saved: SavedState;
  ui: { mode: Mode; editing: ScenarioId; view: ResultsView; units: UnitSystem; ackRevision: number | null; advancedOpen: boolean };
  chat: { messages: ChatMessage[]; proposals: Record<string, ProposalState>; pending: string | null };
};

export const initialState: AppState = {
  config: { stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } },
  baseline: null,
  revision: 0,
  result: null,
  runRequest: null,
  draftOffer: null,
  restoredFixes: [],
  saved: { active: null, snapshot: null, recalculatedFrom: null, status: "idle", error: null, listRevision: 0 },
  ui: { mode: "manual", editing: "stock", view: "compare", units: "imperial", ackRevision: null, advancedOpen: false },
  chat: { messages: [], proposals: {}, pending: null },
};

export type Action =
  | { type: "offerDraft"; draft: DraftOffer }
  | { type: "continueDraft"; record: SavedAnalysis | null }
  | { type: "discardDraft" }
  | { type: "newAnalysis" }
  | { type: "openSaved"; record: SavedAnalysis; verified: boolean | null }
  | { type: "revertToSaved"; record: SavedAnalysis }
  | { type: "recalculate" }
  | { type: "recalcResolved" }
  | { type: "saveSucceeded"; runId: string; active: ActiveSaved }
  | { type: "saveFailed"; runId: string; message: string }
  | { type: "savedListChanged"; renamed?: { id: string; title: string }; removed?: string[]; active?: ActiveSaved }
  | { type: "loadVehicle"; specSet: SpecSet }
  | { type: "clearVehicle" }
  | { type: "setStockValue"; key: SpecKey; value: SpecValues[SpecKey] }
  | { type: "setModifiedValue"; key: SpecKey; value: SpecValues[SpecKey] }
  | { type: "resetField"; scenario: ScenarioId; key: SpecKey }
  | { type: "resetStock" }
  | { type: "resetAll" }
  | { type: "dismissRestored" }
  | { type: "setAdvancedOpen"; open: boolean }
  | { type: "createModified" }
  | { type: "deleteModified" }
  | { type: "setConditions"; patch: Partial<Conditions> }
  | { type: "setConstraint"; scenario: ScenarioId; key: ConstraintKey; value: number | null }
  | { type: "setMode"; mode: Mode }
  | { type: "setEditing"; scenario: ScenarioId }
  | { type: "setView"; view: ResultsView }
  | { type: "setUnits"; units: UnitSystem }
  | { type: "ackWarnings" }
  | { type: "requestRun"; navigate: boolean; source?: "manual" | "assistant" | "recalc" }
  | { type: "runComplete"; analysis: AnalysisResult; revision: number }
  | { type: "runFailed" }
  | { type: "chatSend"; message: ChatMessage }
  | { type: "chatReceive"; requestId: string; message: ChatMessage; proposal: Proposal | null }
  | { type: "chatClear" }
  | { type: "proposalToggle"; proposalId: string; changeId: string }
  | { type: "proposalEdit"; proposalId: string; changeId: string; value: number | string | undefined }
  | { type: "proposalChoose"; proposalId: string; specSet: SpecSet }
  | { type: "proposalCancel"; proposalId: string }
  | { type: "proposalApplied"; proposalId: string; config: AnalysisConfig; baseline: SpecSet | null; view: ResultsView | null };

function withConfig(state: AppState, config: AnalysisConfig): AppState {
  return { ...state, config, revision: state.revision + 1 };
}

const unlinked = (saved: SavedState): SavedState => ({ ...saved, active: null, snapshot: null, recalculatedFrom: null, status: "idle", error: null });

const snapshotOf = (record: SavedAnalysis, verified: boolean | null): SavedState["snapshot"] => ({
  id: record.id,
  engineVersion: record.engineVersion,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  imported: record.origin === "import",
  verified,
});

const fingerprintMatches = (config: AnalysisConfig, record: SavedAnalysis) => fingerprint(config, record.engineVersion) === record.fingerprint;

/** Loads a saved record into the workspace: exact inputs plus the stored (not recomputed) results. */
function loadRecord(state: AppState, record: SavedAnalysis, verified: boolean | null): AppState {
  const revision = state.revision + 1;
  return {
    ...state,
    config: structuredClone(record.result.config),
    baseline: record.baseline ? structuredClone(record.baseline) : null,
    revision,
    result: { analysis: record.result, revision, origin: "saved" },
    runRequest: null,
    restoredFixes: [],
    saved: { ...state.saved, active: toActive(record), snapshot: snapshotOf(record, verified), recalculatedFrom: null, status: "saved", error: null },
    // Warnings were confirmed when the analysis was run; a recalculation needn't ask again.
    ui: { ...state.ui, editing: "stock", view: record.result.modified ? "compare" : "stock", ackRevision: revision },
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "offerDraft":
      return { ...state, draftOffer: action.draft };
    case "continueDraft": {
      const d = state.draftOffer;
      if (!d) return state;
      const record = action.record;
      const matches = !!record && fingerprintMatches(d.config, record);
      const revision = state.revision + 1;
      return {
        ...state,
        config: d.config,
        baseline: d.baseline,
        revision,
        result: matches ? { analysis: record!.result, revision, origin: "saved" } : null,
        draftOffer: null,
        restoredFixes: d.fixes,
        chat: { messages: d.messages, proposals: {}, pending: null },
        saved: record
          ? { ...state.saved, active: toActive(record), snapshot: matches ? snapshotOf(record, null) : null, recalculatedFrom: null, status: "saved", error: null }
          : unlinked(state.saved),
        ui: { ...state.ui, mode: state.ui.mode === "saved" ? "manual" : state.ui.mode, editing: "stock", ackRevision: matches ? revision : null },
      };
    }
    case "discardDraft":
      return { ...state, draftOffer: null };
    case "newAnalysis":
      // Clears only the active workspace: saved analyses and the unit preference are kept.
      return {
        ...initialState,
        revision: state.revision + 1,
        saved: { ...unlinked(state.saved), listRevision: state.saved.listRevision },
        ui: { ...initialState.ui, units: state.ui.units },
      };
    case "openSaved": {
      const next = loadRecord(state, action.record, action.verified);
      return { ...next, draftOffer: null, chat: { messages: [], proposals: {}, pending: null }, ui: { ...next.ui, mode: "results" } };
    }
    case "revertToSaved":
      if (state.saved.active?.id !== action.record.id) return state;
      return loadRecord(state, action.record, state.saved.snapshot?.verified ?? null);
    case "recalculate": {
      if (!state.config.stock || validateConfig(state.config).errors) return state;
      const a = state.saved.active;
      return {
        ...state,
        runRequest: { revision: state.revision, navigate: true, source: "recalc" },
        saved: { ...state.saved, recalculatedFrom: a && isHistorical(a) ? { id: a.id, title: a.title, engineVersion: a.engineVersion } : null },
      };
    }
    case "recalcResolved":
      return { ...state, saved: { ...state.saved, recalculatedFrom: null } };
    case "saveSucceeded":
      if (state.result?.analysis.id !== action.runId) return { ...state, saved: { ...state.saved, listRevision: state.saved.listRevision + 1 } };
      return { ...state, saved: { ...state.saved, active: action.active, status: "saved", error: null, listRevision: state.saved.listRevision + 1 } };
    case "saveFailed":
      if (state.result?.analysis.id !== action.runId) return state;
      return { ...state, saved: { ...state.saved, status: "error", error: action.message } };
    case "savedListChanged": {
      let saved: SavedState = { ...state.saved, listRevision: state.saved.listRevision + 1 };
      if (action.renamed && saved.active?.id === action.renamed.id) saved = { ...saved, active: { ...saved.active, title: action.renamed.title, customTitle: true } };
      if (action.active) saved = { ...saved, active: action.active, status: "saved", error: null };
      if (action.removed && saved.active && action.removed.includes(saved.active.id)) saved = { ...saved, active: null, snapshot: null, status: "idle" };
      if (action.removed && saved.recalculatedFrom && action.removed.includes(saved.recalculatedFrom.id)) saved = { ...saved, recalculatedFrom: null };
      return { ...state, saved };
    }
    case "loadVehicle":
      return {
        ...withConfig(state, { stock: action.specSet, modified: null, conditions: state.config.conditions, constraints: {} }),
        baseline: action.specSet,
        saved: unlinked(state.saved),
        ui: { ...state.ui, editing: "stock" },
      };
    case "clearVehicle":
      return { ...withConfig(state, { ...initialState.config, conditions: state.config.conditions }), baseline: null, result: null, saved: unlinked(state.saved) };
    case "setStockValue":
      if (!state.config.stock) return state;
      return withConfig(state, { ...state.config, stock: setStockValue(state.config.stock, action.key, action.value) });
    case "setModifiedValue": {
      if (!state.config.stock) return state;
      const base = state.config.modified ? state.config : { ...state.config, modified: { overrides: {} } };
      return withConfig(state, setModifiedValue(base, action.key, action.value));
    }
    case "resetField": {
      if (!state.config.stock) return state;
      if (action.scenario === "modified") {
        if (!state.config.modified) return state;
        const overrides = { ...state.config.modified.overrides };
        delete overrides[action.key];
        return withConfig(state, { ...state.config, modified: { overrides } });
      }
      const original = state.baseline?.values[action.key];
      if (!original) return state;
      return withConfig(state, { ...state.config, stock: setStockValue(state.config.stock, action.key, original) });
    }
    case "resetStock":
      if (!state.baseline) return state;
      return withConfig(state, { ...state.config, stock: state.baseline });
    case "resetAll":
      // Back to the vehicle exactly as loaded from its source, no modified scenario, standard conditions.
      return {
        ...withConfig(state, { stock: state.baseline, modified: null, conditions: { ...DEFAULT_CONDITIONS }, constraints: {} }),
        ui: { ...state.ui, editing: "stock", ackRevision: null },
      };
    case "dismissRestored":
      return { ...state, restoredFixes: [] };
    case "setAdvancedOpen":
      return { ...state, ui: { ...state.ui, advancedOpen: action.open } };
    case "createModified":
      if (!state.config.stock) return state;
      return {
        ...withConfig(state, { ...state.config, modified: state.config.modified ?? { overrides: {} } }),
        ui: { ...state.ui, editing: "modified" },
      };
    case "deleteModified":
      return {
        ...withConfig(state, { ...state.config, modified: null, constraints: { stock: state.config.constraints?.stock } }),
        ui: { ...state.ui, editing: "stock" },
      };
    case "setConditions":
      return withConfig(state, { ...state.config, conditions: { ...state.config.conditions, ...action.patch } });
    case "setConstraint": {
      const current = state.config.constraints?.[action.scenario] ?? {};
      const next = { ...current, [action.key]: action.value };
      if (action.value == null) delete (next as Record<string, unknown>)[action.key];
      return withConfig(state, { ...state.config, constraints: { ...state.config.constraints, [action.scenario]: next } });
    }
    case "setMode":
      return { ...state, ui: { ...state.ui, mode: action.mode } };
    case "setEditing":
      if (action.scenario === "modified" && !state.config.modified) return state;
      return { ...state, ui: { ...state.ui, editing: action.scenario } };
    case "setView":
      return { ...state, ui: { ...state.ui, view: action.view } };
    case "setUnits":
      return { ...state, ui: { ...state.ui, units: action.units } };
    case "ackWarnings":
      return { ...state, ui: { ...state.ui, ackRevision: state.revision } };
    case "requestRun":
      if (!state.config.stock || validateConfig(state.config).errors) return state;
      return {
        ...state,
        runRequest: { revision: state.revision, navigate: action.navigate, source: action.source ?? "manual" },
        saved: action.source === "recalc" ? state.saved : { ...state.saved, recalculatedFrom: null },
      };
    case "runFailed":
      return { ...state, runRequest: null };
    case "runComplete": {
      // Ignore results computed for an older configuration.
      if (action.revision !== state.revision) return { ...state, runRequest: null };
      const fromAssistant = state.runRequest?.source === "assistant";
      const messages = fromAssistant
        ? [
            ...state.chat.messages,
            {
              id: `r-${action.analysis.id}`,
              role: "assistant" as const,
              kind: "results" as const,
              text: resultsSummary(action.analysis, state.ui.units),
              createdAt: Date.now(),
              suggestedAction: "open_results" as const,
            },
          ].slice(-60)
        : state.chat.messages;
      return {
        ...state,
        runRequest: null,
        chat: { ...state.chat, messages },
        result: { analysis: action.analysis, revision: action.revision, origin: "run" },
        saved: { ...state.saved, snapshot: null, status: "saving", error: null },
        ui: {
          ...state.ui,
          mode: state.runRequest?.navigate ? "results" : state.ui.mode,
          view: action.analysis.modified ? (state.ui.view === "stock" ? "compare" : state.ui.view) : "stock",
        },
      };
    }
    case "chatSend":
      if (state.chat.pending) return state; // duplicate submission guard
      return { ...state, chat: { ...state.chat, messages: [...state.chat.messages, action.message].slice(-60), pending: action.message.id } };
    case "chatReceive": {
      if (state.chat.pending !== action.requestId) return state; // stale or unknown response
      const proposals = { ...state.chat.proposals };
      if (action.proposal) {
        for (const [id, p] of Object.entries(proposals)) if (p.status === "pending") proposals[id] = { ...p, status: "superseded" };
        const selected = Object.fromEntries(action.proposal.changes.map((c) => [c.id, c.statedByUser]));
        proposals[action.proposal.id] = { proposal: action.proposal, status: "pending", selected, edits: {}, chosen: null };
      }
      return { ...state, chat: { messages: [...state.chat.messages, action.message].slice(-60), proposals, pending: null } };
    }
    case "chatClear":
      return { ...state, chat: { messages: [], proposals: {}, pending: null } };
    case "proposalToggle":
    case "proposalEdit":
    case "proposalChoose":
    case "proposalCancel": {
      const p = state.chat.proposals[action.proposalId];
      if (!p || p.status !== "pending") return state;
      let next: ProposalState = p;
      if (action.type === "proposalToggle") next = { ...p, selected: { ...p.selected, [action.changeId]: !p.selected[action.changeId] } };
      if (action.type === "proposalEdit") {
        const edits = { ...p.edits };
        if (action.value === undefined) delete edits[action.changeId];
        else edits[action.changeId] = action.value;
        next = { ...p, edits };
      }
      if (action.type === "proposalChoose") next = { ...p, chosen: action.specSet };
      if (action.type === "proposalCancel") next = { ...p, status: "cancelled" };
      return { ...state, chat: { ...state.chat, proposals: { ...state.chat.proposals, [action.proposalId]: next } } };
    }
    case "proposalApplied": {
      const p = state.chat.proposals[action.proposalId];
      if (!p || p.status !== "pending") return state;
      return {
        ...withConfig(state, action.config),
        baseline: action.baseline ?? state.baseline,
        saved: action.baseline ? unlinked(state.saved) : state.saved,
        ui: { ...state.ui, view: action.view ?? state.ui.view, editing: action.config.modified ? state.ui.editing : "stock" },
        chat: { ...state.chat, proposals: { ...state.chat.proposals, [action.proposalId]: { ...p, status: "applied" } } },
      };
    }
  }
}

export const isStale = (state: AppState) => !!state.result && state.result.revision !== state.revision;
