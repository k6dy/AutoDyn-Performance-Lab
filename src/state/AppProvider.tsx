"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { appStateReply, isPureAppQuestion } from "@/lib/ai/appState";
import { buildAssistantContext, pendingProposalOf } from "@/lib/ai/context";
import type { AssistantErrorCode, AssistantResponse, AssistantStatus, DeploymentInfo, ProviderCode } from "@/lib/ai/types";
import { AI_LIMITS, isBlocking, PROVIDER_MESSAGES } from "@/lib/ai/types";
import { autosave, replaceOriginal, saveAs as saveAsRecord, toActive } from "@/lib/persistence/autosave";
import { clearDraft, readDraft, readUnitsPref, writeDraft, writeUnitsPref } from "@/lib/persistence/draft";
import { verifyRecord } from "@/lib/persistence/integrity";
import { getRepository, MemoryRepository, setRepository, STORAGE_MESSAGES, toStorageError, type AnalysisRepository } from "@/lib/persistence/repository";
import { hasMeaningfulEdits } from "@/lib/persistence/snapshot";
import { historyFor } from "@/lib/ai/history";
import { classifyRelevance, declineNote, localReply } from "@/lib/ai/relevance";
import { generateTitle, shortVehicle } from "@/lib/ai/titles";
import { describeTopic, type Topic } from "@/lib/ai/topic";
import type { SpecSet } from "@/lib/domain/types";
import {
  getConversations,
  MAX_CONVERSATION_MESSAGES,
  MAX_MESSAGE_TEXT,
  OFFICIAL_SOURCE_URL,
  MemoryConversations,
  newConversationId,
  setConversations,
  withDerived,
  type Conversation,
  type ConversationRepository,
  type StoredMessage,
} from "@/lib/persistence/conversations";
import { vehicleLabel } from "@/lib/vehicles/normalize";
import { ENGINE_VERSION, runAnalysis } from "@/lib/physics/analysis";
import { initialState, isStale, NEW_CHAT_TITLE, reducer, type Action, type AppState, type ChatMessage, type ChatState } from "@/state/reducer";

const ACTIVE_CHAT_KEY = "autodyn:chat:active";

/** The assistant context from the actual workspace: configuration, results (with saved-snapshot state) and any proposal awaiting Apply. */
function contextOf(s: AppState) {
  const snap = s.saved.snapshot;
  return buildAssistantContext(
    s.config,
    s.result ? { analysis: s.result.analysis, stale: isStale(s) } : null,
    s.ui.units,
    pendingProposalOf(Object.values(s.chat.proposals), s.config, s.ui.units),
    snap ? { savedAt: snap.createdAt, engineCurrent: snap.engineVersion === ENGINE_VERSION } : null,
  );
}

/** Local title: the tracked vehicle subject ("Jaguar V8") or the user's words, then the subject's other parts, else the default. */
function titleFor(userTexts: string[], vehicle: SpecSet | null, topic: Topic | null) {
  const t = generateTitle(userTexts, shortVehicle(vehicle?.identity ?? null), topic);
  if (t !== NEW_CHAT_TITLE) return t;
  const subject = describeTopic(topic);
  return subject ? subject.replace(/ · /g, " — ").slice(0, 60) : t;
}

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

export type ChatOps = {
  retry: (messageId: string) => void;
  discard: (messageId: string) => void;
  newChat: () => void;
  open: (id: string) => Promise<OpResult>;
  rename: (id: string, title: string) => Promise<OpResult>;
  remove: (id: string) => Promise<OpResult>;
  clearAll: () => Promise<OpResult>;
  retrySave: () => void;
  /** Sending is paused until this time after a rate-limit or quota response. */
  cooldownUntil: number | null;
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
  chat: ChatOps;
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

async function withChats<T>(fn: (repo: ConversationRepository) => Promise<T>): Promise<T> {
  try {
    return await fn(getConversations());
  } catch (e) {
    const err = toStorageError(e);
    if (err.code === "unavailable" && getConversations().persistent) {
      setConversations(new MemoryConversations());
      return fn(getConversations());
    }
    throw err;
  }
}

const toStored = (m: ChatMessage): StoredMessage => {
  const out: StoredMessage = { id: m.id, role: m.role, text: m.text.slice(0, MAX_MESSAGE_TEXT), createdAt: m.createdAt };
  if (m.kind) out.kind = m.kind;
  if (m.localKind) out.localKind = m.localKind;
  if (m.notices?.length) out.notices = m.notices.slice(0, 10);
  const sources = m.sources?.filter((x) => OFFICIAL_SOURCE_URL.test(x.url)).slice(0, 5);
  if (sources?.length) out.sources = sources;
  if (m.followUp) out.followUp = m.followUp;
  if (m.failed) out.failed = true;
  if (m.errorCode) out.errorCode = String(m.errorCode).slice(0, 40);
  if (m.analysisId) out.analysisId = m.analysisId;
  if (m.proposalNote) out.proposalNote = m.proposalNote;
  return out;
};

/** The stored form of the open conversation (null until it has a message worth keeping). */
function conversationOf(chat: ChatState): Conversation | null {
  if (!chat.id || !chat.messages.some((m) => m.kind !== "local" || m.localKind === "clarify" || m.localKind === "app_state")) return null;
  const last = Math.max(...chat.messages.map((m) => m.createdAt || 0), Date.parse(chat.createdAt ?? "") || 0);
  return withDerived({
    id: chat.id,
    title: chat.title || NEW_CHAT_TITLE,
    customTitle: chat.customTitle,
    createdAt: chat.createdAt ?? new Date(last).toISOString(),
    updatedAt: new Date(last || Date.now()).toISOString(),
    vehicleLabel: chat.vehicle ? vehicleLabel(chat.vehicle.identity).slice(0, 200) : null,
    analysisIds: chat.analysisIds,
    messages: chat.messages.map(toStored),
    vehicle: chat.vehicle,
  });
}

const storage = {
  get: (k: string) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
    } catch {
      // ignore
    }
  },
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [aiStatus, setAiStatus] = useState<AiStatus>({ phase: "checking", code: null, model: null, deployment: null, checkedAt: null });
  const hydrated = useRef(false);
  const inflightChats = useRef(new Set<string>());
  const lastSubmit = useRef<{ text: string; conversationId: string; at: number } | null>(null);
  // Latest unsaved snapshot per conversation: switching chats mid-write must not drop the other chat's newest state.
  const chatWrite = useRef<{ pending: Map<string, Conversation>; busy: boolean; deleted: Set<string> }>({ pending: new Map(), busy: false, deleted: new Set() });
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const latest = useRef(state);
  const savingRun = useRef<string | null>(null);

  useEffect(() => {
    latest.current = state;
  });

  // Once unmounted, queued writes and late replies are dropped instead of touching storage.
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  // After mount (never during render, so no hydration mismatch): restore the unit preference and
  // offer — not apply — the last session's workspace.
  useEffect(() => {
    const units = readUnitsPref();
    if (units) dispatch({ type: "setUnits", units });
    const draft = readDraft();
    if (draft) dispatch({ type: "offerDraft", draft });
    // Reopen the conversation that was open last time (its vehicle is only offered, never applied).
    const lastChat = storage.get(ACTIVE_CHAT_KEY);
    if (lastChat) {
      withChats((repo) => repo.get(lastChat))
        .then((conversation) => {
          if (!latest.current.chat.id && !latest.current.chat.messages.length) dispatch({ type: "chatOpen", conversation });
        })
        .catch(() => storage.set(ACTIVE_CHAT_KEY, null));
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (hydrated.current) writeUnitsPref(state.ui.units);
  }, [state.ui.units]);

  // Autosave the working configuration (separately from completed analyses).
  const { config, baseline, draftOffer } = state;
  const activeId = state.saved.active?.id ?? null;
  useEffect(() => {
    if (!hydrated.current || draftOffer) return; // never overwrite a session the user hasn't answered yet
    const t = window.setTimeout(() => {
      if (!config.stock) return clearDraft();
      // Conversations are stored separately (IndexedDB), not in the draft.
      writeDraft({ config, baseline, activeId, messages: [] });
    }, 300);
    return () => window.clearTimeout(t);
  }, [config, baseline, activeId, draftOffer]);

  // Persist the open conversation after every meaningful change. Writes are coalesced so only the
  // newest snapshot is written, and a conversation deleted meanwhile is never resurrected.
  const flushChat = useCallback(async () => {
    const w = chatWrite.current;
    if (w.busy) return;
    w.busy = true;
    while (w.pending.size) {
      const [id, c] = w.pending.entries().next().value as [string, Conversation];
      w.pending.delete(id);
      if (disposed.current) break;
      if (w.deleted.has(c.id)) continue;
      try {
        await withChats((repo) => repo.put(c));
        if (w.deleted.has(c.id)) await withChats((repo) => repo.delete(c.id));
        dispatch({ type: "chatStored", id: c.id, status: getConversations().persistent ? "saved" : "memory" });
      } catch (e) {
        dispatch({ type: "chatStored", id: c.id, status: "error", message: toStorageError(e).message });
      }
    }
    w.busy = false;
  }, []);

  // Only transcript-relevant fields: storage acknowledgements must not trigger another write.
  const { id: cId, title: cTitle, customTitle: cCustom, createdAt: cCreated, vehicle: cVehicle, analysisIds: cAnalyses, messages: cMessages } = state.chat;
  const record = useMemo(
    () => conversationOf({ ...initialState.chat, id: cId, title: cTitle, customTitle: cCustom, createdAt: cCreated, vehicle: cVehicle, analysisIds: cAnalyses, messages: cMessages }),
    [cId, cTitle, cCustom, cCreated, cVehicle, cAnalyses, cMessages],
  );
  useEffect(() => {
    if (!record) return;
    chatWrite.current.pending.set(record.id, record);
    void flushChat();
  }, [record, flushChat]);

  const chatId = record?.id ?? null;
  useEffect(() => {
    if (hydrated.current) storage.set(ACTIVE_CHAT_KEY, chatId);
  }, [chatId]);

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
        dispatch({ type: "continueDraft", record, conversationId: newConversationId() });
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

  /** Delivers a provider response to its own conversation only — never to whichever chat is open. */
  const deliver = useCallback((conversationId: string, userMessageId: string, requestId: string, body: AssistantResponse) => {
    inflightChats.current.delete(conversationId);
    if (disposed.current) return;
    const s = latest.current;
    const current = s.chat.id === conversationId;
    if (body.ok) {
      if (!body.local) setAiStatus((st) => ({ ...st, phase: "ready", code: null, checkedAt: new Date().toISOString() }));
      const message: ChatMessage = {
        id: `a-${requestId}`,
        role: "assistant",
        text: body.reply,
        createdAt: Date.now(),
        proposalId: body.proposal?.id,
        notices: body.notices,
        ...(body.sources?.length ? { sources: body.sources } : {}),
        followUp: body.followUpQuestion,
        suggestedAction: body.suggestedAction,
        ...(body.local ? { kind: "local" as const } : {}),
      };
      if (current && s.chat.pending === requestId) dispatch({ type: "chatReceive", requestId, conversationId, proposal: body.proposal, message });
      else if (current && !s.chat.pending) dispatch({ type: "chatLate", conversationId, userMessageId, message: { ...message, proposalId: undefined, suggestedAction: null } });
      else if (!current && !chatWrite.current.deleted.has(conversationId)) {
        // The user switched chats while waiting: file the answer in its own conversation.
        void withChats((repo) => repo.append(conversationId, toStored({ ...message, proposalId: undefined })))
          .then(() => dispatch({ type: "chatStored", id: conversationId, status: "saved" }))
          .catch(() => undefined);
      }
      return;
    }
    if (body.code === "rate_limited" || body.code === "provider_rate_limited") setCooldownUntil(Date.now() + Math.min(body.retryAfterS ?? 30, 300) * 1000);
    if (body.code === "quota") setCooldownUntil(Date.now() + 10 * 60_000);
    if (current && s.chat.pending === requestId) dispatch({ type: "chatFailed", requestId, conversationId, messageId: userMessageId, code: body.code });
    if ((PROVIDER_CODES as string[]).includes(body.code) && body.code !== "invalid_output") {
      const code = body.code as ProviderCode;
      setAiStatus((st) => ({ ...st, phase: isBlocking(code) ? "unavailable" : "degraded", code, checkedAt: new Date().toISOString() }));
    }
  }, []);

  const request = useCallback(
    (conversationId: string, userMessage: ChatMessage, history: { role: "user" | "assistant"; text: string }[], requestId: string, detail: boolean) => {
      const fails = (code: AssistantErrorCode) => deliver(conversationId, userMessage.id, requestId, { ok: false, code, message: PROVIDER_MESSAGES[code] });
      if (cooldownUntil && Date.now() < cooldownUntil) return fails("rate_limited");
      if (typeof navigator !== "undefined" && navigator.onLine === false) return fails("offline");
      inflightChats.current.add(conversationId);
      const s = latest.current;
      const context = contextOf(s);
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 30000);
      fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, message: userMessage.text, history, context, detail }),
        signal: controller.signal,
      })
        .then(async (r) => {
          const body = (await r.json().catch(() => null)) as AssistantResponse | null;
          deliver(conversationId, userMessage.id, requestId, body && typeof body === "object" && "ok" in body ? body : { ok: false, code: "server_error", message: PROVIDER_MESSAGES.server_error });
        })
        .catch(() => {
          const code: AssistantErrorCode = controller.signal.aborted ? "timeout" : "network";
          deliver(conversationId, userMessage.id, requestId, { ok: false, code, message: PROVIDER_MESSAGES[code] });
        })
        .finally(() => window.clearTimeout(timer));
    },
    [deliver, cooldownUntil],
  );

  const sendMessage = useCallback(
    (text: string, opts?: { detail?: boolean }) => {
      const s = latest.current;
      const message = text.trim();
      if (!message || s.chat.pending || message.length > AI_LIMITS.maxMessageChars || s.chat.messages.length >= MAX_CONVERSATION_MESSAGES - 2) return;
      const conversationId = s.chat.id ?? newConversationId();
      if (inflightChats.current.has(conversationId)) return; // rapid repeat submission
      // The same text submitted twice before the UI re-renders (double Enter, Enter + click) is one message.
      const last = lastSubmit.current;
      if (last && last.text === message && last.conversationId === (s.chat.id ?? last.conversationId) && Date.now() - last.at < 2000) return;
      lastSubmit.current = { text: message, conversationId, at: Date.now() };
      const now = Date.now();
      const userMessage: ChatMessage = { id: newId(), role: "user", text: message, createdAt: now };
      const vehicle = s.config.stock;
      const history = historyFor(s.chat.messages);

      // Local automotive relevance gate: off-topic, injection, small talk and ambiguous messages are
      // answered here without any network request (the server enforces the same gate).
      const relevance = classifyRelevance(message, { history, hasVehicle: !!vehicle, hasResults: !!s.result });
      const userTexts = [...s.chat.messages.filter((m) => m.role === "user" && (m.kind !== "local" || m.localKind === "clarify")).map((m) => m.text), message];
      const title = s.chat.customTitle || s.chat.title !== NEW_CHAT_TITLE || relevance.decision === "reject" ? null : titleFor(userTexts, vehicle ?? s.chat.vehicle, relevance.topic);
      // Questions about AutoDyn's own state ("Have you run it yet?") are answered from that state, locally.
      const appMessage = relevance.supported ?? message;
      const appAnswer = relevance.decision === "allow" && isPureAppQuestion(appMessage) ? appStateReply(appMessage, contextOf(s)) : null;
      const appReply = appAnswer && relevance.declined?.length ? `${appAnswer}\n\n${declineNote(relevance.declined)}` : appAnswer;
      if (appReply) {
        dispatch({ type: "chatLocal", conversationId, vehicle, localKind: "app_state", title, message: userMessage, reply: { id: `l-${userMessage.id}`, role: "assistant", text: appReply, createdAt: now } });
        return;
      }
      if (relevance.decision !== "allow") {
        const localKind = relevance.decision === "clarify" ? "clarify" : relevance.decision === "small_talk" ? "small_talk" : relevance.basis === "injection" ? "injection" : "off_topic";
        dispatch({
          type: "chatLocal",
          conversationId,
          vehicle,
          localKind,
          title: localKind === "clarify" ? null : title,
          message: userMessage,
          reply: { id: `l-${userMessage.id}`, role: "assistant", text: localReply(relevance)!, createdAt: now },
        });
        return;
      }
      dispatch({ type: "chatSend", conversationId, title, vehicle, message: userMessage });
      request(conversationId, userMessage, history, userMessage.id, !!opts?.detail);
    },
    [request],
  );

  const chatOps = useMemo<ChatOps>(
    () => ({
      cooldownUntil,
      retry: (messageId) => {
        const s = latest.current;
        const i = s.chat.messages.findIndex((m) => m.id === messageId && m.failed);
        if (i < 0 || !s.chat.id || s.chat.pending || inflightChats.current.has(s.chat.id)) return;
        const m = s.chat.messages[i];
        const requestId = `${m.id.slice(0, 40)}r${Date.now().toString(36)}`;
        dispatch({ type: "chatRetry", messageId, requestId });
        request(s.chat.id, m, historyFor(s.chat.messages.slice(0, i)), requestId, false);
      },
      discard: (messageId) => dispatch({ type: "chatDiscard", messageId }),
      newChat: () => dispatch({ type: "chatNew" }),
      open: async (id) => {
        if (latest.current.chat.id === id) return { ok: true };
        try {
          const conversation = await withChats((repo) => repo.get(id));
          dispatch({ type: "chatOpen", conversation });
          return { ok: true };
        } catch (e) {
          return fail(e);
        }
      },
      rename: async (id, title) => {
        const clean = title.replace(/\s+/g, " ").trim().slice(0, 120);
        if (!clean) return { ok: false, message: "Enter a title." };
        try {
          if (latest.current.chat.id !== id || !conversationOf(latest.current.chat)) await withChats((repo) => repo.rename(id, clean));
          dispatch({ type: "chatRenamed", id, title: clean });
          return { ok: true };
        } catch (e) {
          return fail(e);
        }
      },
      remove: async (id) => {
        try {
          chatWrite.current.deleted.add(id);
          await withChats((repo) => repo.delete(id));
          dispatch({ type: "chatDeleted", ids: [id] });
          return { ok: true };
        } catch (e) {
          chatWrite.current.deleted.delete(id);
          return fail(e);
        }
      },
      clearAll: async () => {
        try {
          const { items } = await withChats((repo) => repo.list());
          for (const m of items) chatWrite.current.deleted.add(m.id);
          if (latest.current.chat.id) chatWrite.current.deleted.add(latest.current.chat.id);
          chatWrite.current.pending.clear();
          await withChats((repo) => repo.clear());
          dispatch({ type: "chatDeleted", ids: "all" });
          return { ok: true };
        } catch (e) {
          return fail(e);
        }
      },
      retrySave: () => {
        const c = conversationOf(latest.current.chat);
        if (!c) return;
        chatWrite.current.pending.set(c.id, c);
        void flushChat();
      },
    }),
    [cooldownUntil, request, flushChat],
  );

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
      chat: chatOps,
    }),
    [state, runAnalysisNow, aiStatus, checkConnection, sendMessage, saved, unsavedEdits, chatOps],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
