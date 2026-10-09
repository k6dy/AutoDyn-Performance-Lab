"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { buildAssistantContext } from "@/lib/ai/context";
import type { AssistantErrorCode, AssistantResponse, AssistantStatus, DeploymentInfo, ProviderCode } from "@/lib/ai/types";
import { AI_LIMITS, isBlocking, PROVIDER_MESSAGES } from "@/lib/ai/types";
import { configSchema, specSetSchema } from "@/lib/domain/configSchema";
import { sanitizeRestored } from "@/lib/domain/sanitize";
import type { AnalysisConfig, SpecSet } from "@/lib/domain/types";
import { runAnalysis } from "@/lib/physics/analysis";
import { initialState, isStale, reducer, type Action, type AppState, type ChatMessage } from "@/state/reducer";

// v3: earlier builds could persist arbitrary manual test values; they are not restored.
const STORAGE_KEY = "autodyn:v3";

export type AiStatus = {
  /** checking: request in flight · ready: provider verified · untested: configured, not yet probed · unavailable: cannot be used. */
  phase: "checking" | "ready" | "untested" | "unavailable" | "degraded";
  code: ProviderCode | null;
  model: string | null;
  deployment: DeploymentInfo | null;
  checkedAt: string | null;
};

const PROVIDER_CODES: ProviderCode[] = ["not_configured", "invalid_key", "model_unavailable", "quota", "timeout", "network", "server_error", "request_rejected", "invalid_output"];

function statusFrom(s: AssistantStatus): AiStatus {
  const base = { model: s.model, deployment: s.deployment, checkedAt: s.provider?.checkedAt ?? null };
  if (!s.configured) return { ...base, phase: "unavailable", code: "not_configured" };
  if (!s.provider) return { ...base, phase: "untested", code: null };
  if (s.provider.status === "ok") return { ...base, phase: "ready", code: null };
  return { ...base, phase: isBlocking(s.provider.status) ? "unavailable" : "degraded", code: s.provider.status };
}

type Ctx = {
  state: AppState;
  dispatch: (a: Action) => void;
  stale: boolean;
  running: boolean;
  runAnalysisNow: (navigate?: boolean) => void;
  aiStatus: AiStatus;
  checkConnection: () => void;
  sendMessage: (text: string, opts?: { detail?: boolean }) => void;
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

function readStorage(): Extract<Action, { type: "hydrate" }>["state"] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.version !== 3) return null;
    const config = configSchema.safeParse(data.config);
    if (!config.success) return null;
    const baseline = data.baseline ? specSetSchema.safeParse(data.baseline) : null;
    const messages: ChatMessage[] = Array.isArray(data.messages)
      ? data.messages
          .filter((m: ChatMessage) => (m?.role === "user" || m?.role === "assistant") && typeof m.text === "string")
          .map((m: ChatMessage) => ({ id: String(m.id), role: m.role, text: m.text.slice(0, 4000), createdAt: Number(m.createdAt) || 0, notices: Array.isArray(m.notices) ? m.notices.map(String) : undefined }))
          .slice(-40)
      : [];
    const restoredBaseline = baseline?.success ? (baseline.data as SpecSet) : null;
    const clean = sanitizeRestored(config.data as AnalysisConfig, restoredBaseline);
    return {
      config: clean.config,
      sanitized: clean.fixed,
      baseline: restoredBaseline,
      chat: { messages, proposals: {}, pending: null },
      units: data.units === "metric" ? "metric" : "imperial",
    };
  } catch {
    return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ phase: "checking", code: null, model: null, deployment: null, checkedAt: null });
  const hydrated = useRef(false);
  const inflight = useRef(false);

  // Restore the last session after mount (never during render, so no hydration mismatch).
  useEffect(() => {
    const saved = readStorage();
    if (saved) dispatch({ type: "hydrate", state: saved });
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: 3,
            config: state.config,
            baseline: state.baseline,
            units: state.ui.units,
            messages: state.chat.messages.slice(-40).map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt, notices: m.notices })),
          }),
        );
      } catch {
        // Storage may be unavailable (private mode); the session still works.
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [state.config, state.baseline, state.ui.units, state.chat.messages]);

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
  const { runRequest, config } = state;
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
    () => ({ state, dispatch, stale: isStale(state), running: state.runRequest !== null, runAnalysisNow, aiStatus, checkConnection, sendMessage }),
    [state, runAnalysisNow, aiStatus, checkConnection, sendMessage],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
