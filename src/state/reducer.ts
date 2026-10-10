// Application state. Pure reducer so behavior (mode switching, staleness, confirmation-gated AI
// changes) is unit-testable without rendering.

import type { AssistantErrorCode, Proposal, SuggestedAction } from "@/lib/ai/types";
import { resultsSummary } from "@/lib/analysis/summary";
import { setModifiedValue, setStockValue } from "@/lib/domain/scenario";
import type { AnalysisConfig, Conditions, ConstraintKey, ScenarioId, SpecKey, SpecSet, SpecValues } from "@/lib/domain/types";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import type { AnalysisResult } from "@/lib/physics/analysis";
import type { UnitSystem } from "@/lib/units";

export type Mode = "manual" | "assistant" | "results";
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

export type AppState = {
  config: AnalysisConfig;
  /** Vehicle exactly as loaded from its provider; used for per-field and full resets. */
  baseline: SpecSet | null;
  revision: number;
  result: { analysis: AnalysisResult; revision: number } | null;
  /** Revision a run was requested for; the provider computes it after the state commits. */
  runRequest: { revision: number; navigate: boolean; source: "manual" | "assistant" } | null;
  /** True when the configuration was restored from a previous browser session. */
  restored: boolean;
  /** Saved values that were physically invalid and were reset during restore. */
  restoredFixes: string[];
  ui: { mode: Mode; editing: ScenarioId; view: ResultsView; units: UnitSystem; ackRevision: number | null; advancedOpen: boolean };
  chat: { messages: ChatMessage[]; proposals: Record<string, ProposalState>; pending: string | null };
};

export const initialState: AppState = {
  config: { stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } },
  baseline: null,
  revision: 0,
  result: null,
  runRequest: null,
  restored: false,
  restoredFixes: [],
  ui: { mode: "manual", editing: "stock", view: "compare", units: "imperial", ackRevision: null, advancedOpen: false },
  chat: { messages: [], proposals: {}, pending: null },
};

export type Action =
  | { type: "hydrate"; state: Pick<AppState, "config" | "baseline" | "chat"> & { units: UnitSystem; sanitized?: string[] } }
  | { type: "loadVehicle"; specSet: SpecSet }
  | { type: "clearVehicle" }
  | { type: "setStockValue"; key: SpecKey; value: SpecValues[SpecKey] }
  | { type: "setModifiedValue"; key: SpecKey; value: SpecValues[SpecKey] }
  | { type: "resetField"; scenario: ScenarioId; key: SpecKey }
  | { type: "resetStock" }
  | { type: "resetAll" }
  | { type: "startFresh" }
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
  | { type: "requestRun"; navigate: boolean; source?: "manual" | "assistant" }
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

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        config: action.state.config,
        baseline: action.state.baseline,
        chat: { ...action.state.chat, pending: null },
        ui: { ...state.ui, units: action.state.units },
        revision: state.revision + 1,
        restored: !!action.state.config.stock,
        restoredFixes: action.state.sanitized ?? [],
      };
    case "loadVehicle":
      return {
        ...withConfig(state, { stock: action.specSet, modified: null, conditions: state.config.conditions, constraints: {} }),
        baseline: action.specSet,
        ui: { ...state.ui, editing: "stock" },
      };
    case "clearVehicle":
      return { ...withConfig(state, { ...initialState.config, conditions: state.config.conditions }), baseline: null, result: null };
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
    case "startFresh":
      return { ...initialState, revision: state.revision + 1, ui: { ...initialState.ui, units: state.ui.units } };
    case "dismissRestored":
      return { ...state, restored: false, restoredFixes: [] };
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
      return { ...state, runRequest: { revision: state.revision, navigate: action.navigate, source: action.source ?? "manual" } };
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
        result: { analysis: action.analysis, revision: action.revision },
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
        ui: { ...state.ui, view: action.view ?? state.ui.view, editing: action.config.modified ? state.ui.editing : "stock" },
        chat: { ...state.chat, proposals: { ...state.chat.proposals, [action.proposalId]: { ...p, status: "applied" } } },
      };
    }
  }
}

export const isStale = (state: AppState) => !!state.result && state.result.revision !== state.revision;
