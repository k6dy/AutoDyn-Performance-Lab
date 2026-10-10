"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { buildAssistantContext } from "@/lib/ai/context";
import type { AssistantErrorCode, AssistantResponse, AssistantStatus, DeploymentInfo, ProviderCode } from "@/lib/ai/types";
import { AI_LIMITS, isBlocking, PROVIDER_MESSAGES } from "@/lib/ai/types";
import { autosave, replaceOriginal, saveAs as saveAsRecord, toActive } from "@/lib/persistence/autosave";
import { clearDraft, readDraft, readUnitsPref, writeDraft, writeUnitsPref } from "@/lib/persistence/draft";
import { verifyRecord } from "@/lib/persistence/integrity";
import { getRepository, MemoryRepository, setRepository, STORAGE_MESSAGES, toStorageError, type AnalysisRepository } from "@/lib/persistence/repository";
import { hasMeaningfulEdits } from "@/lib/persistence/snapshot";
import { runAnalysis } from "@/lib/physics/analysis";
import { initialState, isStale, reducer, type Action, type AppState } from "@/state/reducer";

export type AiStatus = {
  /** checking: request in flight · ready: provider verified · untested: configured, not yet probed · unavailable: cannot be used. */
  phase: "checking" | "ready" | "untested" | "unavailable" | "degraded";
  code: ProviderCode | null;
  model: string | null;
  deployment: DeploymentInfo | null;
  checkedAt: string | null;
  /** Sanitized provider diagnostics for the last failure (no secrets). */
  detail?: string | null;
  servedBy?: string | null;
  configNotes?: string[];
  env?: AssistantStatus["env"];
  /** How readiness was established: a real request, a generation probe, or key/model metadata only. */
  verifiedBy?: "request" | "probe" | "access" | null;
};

const PROVIDER_CODES: ProviderCode[] = ["not_configured", "invalid_key", "key_restricted", "model_unavailable", "model_unsupported", "quota", "provider_rate_limited", "timeout", "network", "server_error", "request_rejected", "invalid_output", "internal_error"];

function statusFrom(s: AssistantStatus): AiStatus {
  const p = s.provider;
  const base = {
    model: s.model,
    deployment: s.deployment,
    checkedAt: p?.checkedAt ?? null,
    detail: p && p.status !== "ok" && (p.httpStatus || p.reason) ? [p.httpStatus ? `HTTP ${p.httpStatus}` : null, p.reason].filter(Boolean).join(" · ") : null,
    servedBy: p?.servedBy && p.servedBy !== s.model ? p.servedBy : null,
    configNotes: s.configNotes ?? [],
    env: s.env,
    verifiedBy: p?.status === "ok" ? p.source : null,
  };
  if (!s.configured) return { ...base, phase: "unavailable", code: "not_configured" };
  if (!s.provider) return { ...base, phase: "untested", code: null };
  if (s.provider.status === "ok") return { ...base, phase: "ready", code: null };
  return { ...base, phase: isBlocking(s.provider.status) ? "unavailable" : "degraded", code: s.provider.status };
}

export type OpResult = { ok: true } | { ok: false; message: string };

export type SavedOps = {
  /** True when the workspace holds edits that New Analysis / opening another analysis would discard. */
  unsavedEdits: boolean;
  newAnalysis: () => void;
  continueDraft: () => Promise<void>;
  discardDraft: () => void;
  open: (id: string) => Promise<OpResult>;
  retrySave: () => void;
  saveAs: (title: string) => Promise<OpResult>;
  replaceOriginal: () => Promise<OpResult>;
  revertToSaved: () => Promise<OpResult>;
  recalculate: () => void;
};

type Ctx = {
  state: AppState;
  dispatch: (a: Action) => void;
  stale: boolean;
  running: boolean;
  runAnalysisNow: (navigate?: boolean) => void;
  aiStatus: AiStatus;
  checkConnection: () => void;
  sendMessage: (text: string, opts?: { detail?: boolean }) => void;
  saved: SavedOps;
};

const AppContext = createContext<Ctx | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

/** Runs a storage operation; if IndexedDB can't be opened at all, continues in memory for this tab. */
async function withRepo<T>(fn: (repo: AnalysisRepository) => Promise<T>): Promise<T> {
  try {
    return await fn(getRepository());
  } catch (e) {
    const err = toStorageError(e);
    if (err.code === "unavailable" && getRepository().persistent) {
      setRepository(new MemoryRepository());
      return fn(getRepository());
    }
    throw err;
  }
}

const fail = (e: unknown): OpResult => ({ ok: false, message: toStorageError(e).message });

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ phase: "checking", code: null, model: null, deployment: null, checkedAt: null });
  const hydrated = useRef(false);
  const inflight = useRef(false);
  const latest = useRef(state);
  const savingRun = useRef<string | null>(null);

  useEffect(() => {
    latest.current = state;
  });

  // After mount (never during render, so no hydration mismatch): restore the unit preference and
  // offer — not apply — the last session's workspace.
  useEffect(() => {
    const units = readUnitsPref();
    if (units) dispatch({ type: "setUnits", units });
    const draft = readDraft();
    if (draft) dispatch({ type: "offerDraft", draft });
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (hydrated.current) writeUnitsPref(state.ui.units);
  }, [state.ui.units]);

  // Autosave the working configuration (separately from completed analyses).
  const { config, baseline, draftOffer } = state;
  const activeId = state.saved.active?.id ?? null;
  const messages = state.chat.messages;
  useEffect(() => {
    if (!hydrated.current || draftOffer) return; // never overwrite a session the user hasn't answered yet
    const t = window.setTimeout(() => {
      if (!config.stock) return clearDraft();
      writeDraft({
        config,
        baseline,
        activeId,
        messages: messages
          .filter((m) => !m.errorCode)
          .slice(-40)
          .map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt, notices: m.notices })),
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [config, baseline, activeId, messages, draftOffer]);

  // Preserve every completed run automatically (see persistence/autosave for the rules).
  const persist = useCallback(async () => {
    const s = latest.current;
    const r = s.result;
    if (!r || r.origin !== "run") return;
    const runId = r.analysis.id;
    try {
      const outcome = await withRepo((repo) =>
        autosave(repo, { result: r.analysis, baseline: s.baseline, units: s.ui.units, active: s.saved.active, recalculatedFrom: s.saved.recalculatedFrom }),
      );
      dispatch({ type: "saveSucceeded", runId, active: toActive(outcome.meta) });
    } catch (e) {
      dispatch({ type: "saveFailed", runId, message: toStorageError(e).message });
    }
  }, []);

  const result = state.result;
  useEffect(() => {
    if (!result || result.origin !== "run" || savingRun.current === result.analysis.id) return;
    savingRun.current = result.analysis.id;
    void persist();
  }, [result, persist]);

  const saved = useMemo<SavedOps>(() => {
    const ops: Omit<SavedOps, "unsavedEdits"> = {
      newAnalysis: () => {
        clearDraft();
        dispatch({ type: "newAnalysis" });
      },
      continueDraft: async () => {
        const d = latest.current.draftOffer;
        if (!d) return;
        let record = null;
        if (d.activeId) record = await withRepo((repo) => repo.get(d.activeId!)).catch(() => null);
        dispatch({ type: "continueDraft", record });
      },
      discardDraft: () => {
        clearDraft();
        dispatch({ type: "discardDraft" });
      },
      open: async (id) => {
        try {
          const record = await withRepo((repo) => repo.get(id));
          // Imported results were computed elsewhere: check they follow from their inputs.
          const verified = record.origin === "import" ? verifyRecord(record) : null;
          dispatch({ type: "openSaved", record, verified });
          return { ok: true };
        } catch (e) {
          return fail(e);
        }
      },
      retrySave: () => {
        savingRun.current = latest.current.result?.analysis.id ?? null;
        void persist();
      },
      saveAs: async (title) => {
        const s = latest.current;
        if (!s.result) return { ok: false, message: "Run an analysis first." };
        try {
          const meta = await withRepo((repo) =>
            saveAsRecord(repo, { result: s.result!.analysis, baseline: s.baseline, units: s.ui.units, title, sourceId: s.saved.active?.id ?? null }),
          );
          dispatch({ type: "savedListChanged", active: toActive(meta) });
          return { ok: true };
        } catch (e) {
          return fail(e);
        }
      },
      replaceOriginal: async () => {
        const s = latest.current.saved;
        if (!s.recalculatedFrom || !s.active) return { ok: false, message: STORAGE_MESSAGES.not_found };
        try {
          const meta = await withRepo((repo) => replaceOriginal(repo, s.recalculatedFrom!.id, s.active!.id));
          dispatch({ type: "savedListChanged", active: toActive(meta), removed: [s.active.id] });
          dispatch({ type: "recalcResolved" });
          return { ok: true };
        } catch (e) {
          return fail(e);
        }
      },
      revertToSaved: async () => {
        const id = latest.current.saved.active?.id;
        if (!id) return { ok: false, message: STORAGE_MESSAGES.not_found };
        try {
          const record = await withRepo((repo) => repo.get(id));
          dispatch({ type: "revertToSaved", record });
          return { ok: true };
        } catch (e) {
          return fail(e);
        }
      },
      recalculate: () => dispatch({ type: "recalculate" }),
    };
    return { ...ops, unsavedEdits: false };
  }, [persist]);

  const unsavedEdits = useMemo(() => hasMeaningfulEdits(config, baseline, state.saved.active), [config, baseline, state.saved.active]);

  const loadStatus = useCallback((probe: boolean) => {
    return fetch(probe ? "/api/assistant/health?probe=1" : "/api/assistant", { cache: "no-store", signal: AbortSignal.timeout(20000) })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setAiStatus(statusFrom((await r.json()) as AssistantStatus));
      })
      .catch(() => setAiStatus((s) => ({ ...s, phase: "degraded", code: "network" })));
  }, []);

  useEffect(() => {
    loadStatus(false);
  }, [loadStatus]);

  const checkConnection = useCallback(() => {
    setAiStatus((s) => ({ ...s, phase: "checking" }));
    loadStatus(true);
  }, [loadStatus]);

  const runAnalysisNow = useCallback((navigate = true) => dispatch({ type: "requestRun", navigate, source: "manual" }), []);

  // Runs the deterministic engine for the revision that was requested, after the state commits.
  const { runRequest } = state;
  useEffect(() => {
    if (!runRequest) return;
    // Yield a frame so the running state paints before the synchronous computation.
    const t = window.setTimeout(() => {
      try {
        dispatch({ type: "runComplete", analysis: runAnalysis(config), revision: runRequest.revision });
      } catch {
        dispatch({ type: "runFailed" });
      }
    }, 30);
    return () => window.clearTimeout(t);
  }, [runRequest, config]);

  const sendMessage = useCallback((text: string, opts?: { detail?: boolean }) => {
    const s = state;
    const message = text.trim();
    if (!message || s.chat.pending || inflight.current || message.length > AI_LIMITS.maxMessageChars) return;
    inflight.current = true;
    const id = newId();
    dispatch({ type: "chatSend", message: { id, role: "user", text: message, createdAt: Date.now() } });

    const history = s.chat.messages
      .filter((m) => !m.errorCode)
      .slice(-AI_LIMITS.maxHistoryTurns)
      .map((m) => ({ role: m.role, text: m.text.slice(0, AI_LIMITS.maxHistoryChars) }));
    const context = buildAssistantContext(s.config, s.result ? { analysis: s.result.analysis, stale: isStale(s) } : null, s.ui.units);

    const finish = (body: AssistantResponse) => {
      inflight.current = false;
      if (body.ok) {
        setAiStatus((st) => ({ ...st, phase: "ready", code: null, checkedAt: new Date().toISOString() }));
        dispatch({
          type: "chatReceive",
          requestId: id,
          proposal: body.proposal,
          message: {
            id: `a-${id}`,
            role: "assistant",
            text: body.reply,
            createdAt: Date.now(),
            proposalId: body.proposal?.id,
            notices: body.notices,
            followUp: body.followUpQuestion,
            suggestedAction: body.suggestedAction,
          },
        });
      } else {
        dispatch({
          type: "chatReceive",
          requestId: id,
          proposal: null,
          message: { id: `a-${id}`, role: "assistant", text: body.message, createdAt: Date.now(), errorCode: body.code },
        });
        if ((PROVIDER_CODES as string[]).includes(body.code) && body.code !== "invalid_output") {
          const code = body.code as ProviderCode;
          setAiStatus((st) => ({ ...st, phase: isBlocking(code) ? "unavailable" : "degraded", code, checkedAt: new Date().toISOString() }));
        }
      }
    };

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30000);
    fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: id, message, history, context, detail: !!opts?.detail }),
      signal: controller.signal,
    })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as AssistantResponse | null;
        finish(body && typeof body === "object" && "ok" in body ? body : { ok: false, code: "server_error", message: PROVIDER_MESSAGES.server_error });
      })
      .catch(() => {
        const code: AssistantErrorCode = controller.signal.aborted ? "timeout" : "network";
        finish({ ok: false, code, message: PROVIDER_MESSAGES[code] });
      })
      .finally(() => window.clearTimeout(timer));
  }, [state]);

  const value = useMemo<Ctx>(
    () => ({
      state,
      dispatch,
      stale: isStale(state),
      running: state.runRequest !== null,
      runAnalysisNow,
      aiStatus,
      checkConnection,
      sendMessage,
      saved: { ...saved, unsavedEdits },
    }),
    [state, runAnalysisNow, aiStatus, checkConnection, sendMessage, saved, unsavedEdits],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
