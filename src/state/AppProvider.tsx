"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { buildAssistantContext } from "@/lib/ai/context";
import type { AssistantResponse } from "@/lib/ai/types";
import { AI_LIMITS, AI_UNAVAILABLE_MESSAGE } from "@/lib/ai/types";
import { configSchema, specSetSchema } from "@/lib/domain/configSchema";
import type { AnalysisConfig, SpecSet } from "@/lib/domain/types";
import { runAnalysis } from "@/lib/physics/analysis";
import { initialState, isStale, reducer, type Action, type AppState, type ChatMessage } from "@/state/reducer";

const STORAGE_KEY = "autodyn:v2";

type AiStatus = "checking" | "available" | "unavailable";

type Ctx = {
  state: AppState;
  dispatch: (a: Action) => void;
  stale: boolean;
  running: boolean;
  runAnalysisNow: (navigate?: boolean) => void;
  aiStatus: AiStatus;
  sendMessage: (text: string) => void;
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
    if (data?.version !== 2) return null;
    const config = configSchema.safeParse(data.config);
    if (!config.success) return null;
    const baseline = data.baseline ? specSetSchema.safeParse(data.baseline) : null;
    const messages: ChatMessage[] = Array.isArray(data.messages)
      ? data.messages
          .filter((m: ChatMessage) => (m?.role === "user" || m?.role === "assistant") && typeof m.text === "string")
          .map((m: ChatMessage) => ({ id: String(m.id), role: m.role, text: m.text.slice(0, 4000), createdAt: Number(m.createdAt) || 0, notices: Array.isArray(m.notices) ? m.notices.map(String) : undefined }))
          .slice(-40)
      : [];
    return {
      config: config.data as AnalysisConfig,
      baseline: baseline?.success ? (baseline.data as SpecSet) : null,
      chat: { messages, proposals: {}, pending: null },
      units: data.units === "metric" ? "metric" : "imperial",
    };
  } catch {
    return null;
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [aiStatus, setAiStatus] = useState<AiStatus>("checking");
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
            version: 2,
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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/assistant", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && setAiStatus(d?.available ? "available" : "unavailable"))
      .catch(() => !cancelled && setAiStatus("unavailable"));
    return () => {
      cancelled = true;
    };
  }, []);

  const runAnalysisNow = useCallback((navigate = true) => dispatch({ type: "requestRun", navigate }), []);

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

  const sendMessage = useCallback((text: string) => {
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
        if (body.code === "ai_unavailable") setAiStatus("unavailable");
      }
    };

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30000);
    fetch("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: id, message, history, context }),
      signal: controller.signal,
    })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as AssistantResponse | null;
        finish(body && typeof body === "object" && "ok" in body ? body : { ok: false, code: "provider_error", message: AI_UNAVAILABLE_MESSAGE });
      })
      .catch(() => finish({ ok: false, code: controller.signal.aborted ? "timeout" : "provider_error", message: AI_UNAVAILABLE_MESSAGE }))
      .finally(() => window.clearTimeout(timer));
  }, [state]);

  const value = useMemo<Ctx>(
    () => ({ state, dispatch, stale: isStale(state), running: state.runRequest !== null, runAnalysisNow, aiStatus, sendMessage }),
    [state, runAnalysisNow, aiStatus, sendMessage],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
