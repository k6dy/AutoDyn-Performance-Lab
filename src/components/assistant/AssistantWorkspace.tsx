"use client";

import { Archive, ArrowUp, CarFront, Cog, Gauge, History, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Pencil, Play, PlugZap, RotateCcw, Scale, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ChatHistory from "@/components/assistant/ChatHistory";
import Markdown from "@/components/assistant/Markdown";
import ProposalPanel from "@/components/assistant/ProposalPanel";
import { ConfirmDialog, Dialog, PromptDialog } from "@/components/Dialog";
import LoadingStage, { BrandGlyph } from "@/components/LoadingStage";
import { Button, cx, Kbd, Panel, ProvenanceTag, Spinner } from "@/components/ui";
import { displaySpec } from "@/lib/ai/context";
import { omittedCount } from "@/lib/ai/history";
import { deriveTopic, describeTopic } from "@/lib/ai/topic";
import { AI_LIMITS, AI_UNAVAILABLE_MESSAGE, isBlocking, PROVIDER_MESSAGES } from "@/lib/ai/types";
import { SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveValues, modifiedDiff } from "@/lib/domain/scenario";
import type { SpecKey } from "@/lib/domain/types";
import { MAX_CONVERSATION_MESSAGES, OFFICIAL_SOURCE_URL } from "@/lib/persistence/conversations";
import { getRepository } from "@/lib/persistence/repository";
import { vehicleKey } from "@/lib/persistence/snapshot";
import { vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp, type AiStatus } from "@/state/AppProvider";
import type { ChatMessage, ProposalState } from "@/state/reducer";

const PROBED_KEY = "autodyn:ai-probed";

export function statusText(s: AiStatus) {
  if (s.phase === "checking") return "Checking AI connection…";
  if (s.phase === "ready") return s.verifiedBy === "access" ? "Connected — API key and model verified" : "Connected";
  if (s.phase === "untested") return "Configured — connection not yet verified";
  return s.code ? PROVIDER_MESSAGES[s.code] : AI_UNAVAILABLE_MESSAGE;
}

/** Exact remedy for a deployment whose server runtime has no Gemini key. */
function SetupSteps() {
  const { aiStatus } = useApp();
  const d = aiStatus.deployment;
  const missing = ["GEMINI_API_KEY", aiStatus.env && !aiStatus.env.GEMINI_MODEL ? "GEMINI_MODEL" : null].filter(Boolean).join(" and ");
  if (!d || d.environment === "local") {
    return <p className="mt-1 text-xs leading-4 text-muted">Add {missing} to .env.local and restart the server.</p>;
  }
  const env = d.environment === "production" ? "Production" : "Preview";
  return (
    <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-xs leading-4 text-muted" data-testid="ai-setup-steps">
      <li>
        This {env.toLowerCase()} deployment&apos;s server runtime has no {missing}. Variables are attached when a deployment is created.
      </li>
      <li>
        In Vercel, open the project that serves this URL{d.project ? ` (production domain ${d.project})` : ""} → Settings → Environment Variables. If several projects deploy this
        repository, the variables must be on this one.
      </li>
      <li>
        Add {missing} for the {env} environment{env === "Preview" && d.branch ? ` (all Preview branches, or branch “${d.branch}”)` : ""}.
      </li>
      <li>Redeploy{d.branch ? ` ${d.branch}` : ""} — existing deployments never receive variables added later.</li>
    </ol>
  );
}

function ConnectionBar() {
  const { aiStatus, checkConnection, dispatch } = useApp();
  const bad = aiStatus.phase === "unavailable" || aiStatus.phase === "degraded";
  const d = aiStatus.deployment;
  return (
    <div className={cx("border-b px-4 py-2.5 sm:px-5", bad ? "border-warning/30 bg-warning/5" : "border-line")} data-ai-phase={aiStatus.phase}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <span
            aria-hidden
            className={cx(
              "h-2 w-2 shrink-0 rounded-full",
              aiStatus.phase === "ready" ? "bg-success" : aiStatus.phase === "checking" ? "loading-dot bg-accent" : bad ? "bg-warning" : "bg-faint",
            )}
          />
          <span className={cx("min-w-0", bad ? "text-[#f1d39e]" : "text-muted")}>{bad ? AI_UNAVAILABLE_MESSAGE : statusText(aiStatus)}</span>
        </div>
        <div className="flex gap-2">
          {aiStatus.phase !== "checking" && aiStatus.code !== "not_configured" && (
            <Button size="sm" variant="ghost" onClick={checkConnection}>
              <PlugZap size={14} aria-hidden /> Test connection
            </Button>
          )}
          {bad && (
            <Button size="sm" onClick={() => dispatch({ type: "setMode", mode: "manual" })}>
              Open Manual Setup
            </Button>
          )}
        </div>
      </div>
      {bad && aiStatus.code && (
        <p className="mt-1 text-xs leading-4 text-muted">
          Reason: {PROVIDER_MESSAGES[aiStatus.code]}
          {aiStatus.detail && <span className="text-faint"> (provider response: {aiStatus.detail})</span>}
        </p>
      )}
      {aiStatus.code === "not_configured" && <SetupSteps />}
      {aiStatus.servedBy && <p className="mt-1 text-xs text-warning">Configured model unavailable — answered by fallback model {aiStatus.servedBy}.</p>}
      {(bad || aiStatus.phase === "untested") && aiStatus.configNotes?.map((n) => (
        <p key={n} className="mt-1 text-xs text-warning">
          Configuration: {n}
        </p>
      ))}
      {d && (bad || aiStatus.phase === "untested") && (
        <p className="mt-1 text-[11px] text-faint">
          Deployment: {d.environment}
          {d.project ? ` · ${d.project}` : ""}
          {d.branch ? ` · ${d.branch}` : ""}
          {d.commit ? ` @ ${d.commit}` : ""}
          {aiStatus.model ? ` · model ${aiStatus.model}` : ""}
        </p>
      )}
    </div>
  );
}

function Message({ m, proposal }: { m: ChatMessage; proposal?: ProposalState }) {
  const { dispatch, runAnalysisNow, running, sendMessage, state, aiStatus, chat, saved } = useApp();
  const [linkState, setLinkState] = useState<"idle" | "opening" | "missing">("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (m.role === "user") {
    return (
      <div className="animate-enter flex flex-col items-end gap-1.5" data-message-role="user">
        <div className={cx("max-w-[85%] rounded-lg border bg-raised px-3.5 py-2.5 text-[14px] leading-6 whitespace-pre-line text-ink [overflow-wrap:anywhere]", m.failed ? "border-error/40" : "border-line")}>{m.text}</div>
        {m.failed && (
          <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-2 text-xs" role="alert">
            <span className="text-error">Not sent: {PROVIDER_MESSAGES[m.errorCode as keyof typeof PROVIDER_MESSAGES] ?? "The request didn't complete."}</span>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => chat.retry(m.id)} disabled={!!state.chat.pending}>
              <RotateCcw size={12} aria-hidden /> Retry
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => chat.discard(m.id)}>
              Remove
            </Button>
          </div>
        )}
      </div>
    );
  }
  const canAsk = !state.chat.pending && !isBlocking(aiStatus.code ?? undefined);
  const openLinked = async () => {
    if (!m.analysisId) return;
    setConfirmOpen(false);
    setLinkState("opening");
    const r = await saved.open(m.analysisId);
    setLinkState(r.ok ? "idle" : "missing");
  };
  return (
    <div className="animate-enter max-w-[92%] min-w-0 space-y-2" data-message-role="assistant">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium tracking-wide text-faint uppercase">
        {m.kind === "results" ? "Physics engine" : "AutoDyn assistant"}
        {m.kind === "results" && <ProvenanceTag provenance="verified" title="Computed deterministically — not AI-generated" />}
        {m.kind === "local" && (
          <span className="font-normal tracking-normal normal-case">{m.localKind === "clarify" ? "· clarifying locally, no AI request" : m.localKind === "app_state" ? "· from AutoDyn's current state, no AI request" : "· answered locally, no AI request"}</span>
        )}
      </div>
      <div className={cx("text-[14px] leading-6 [overflow-wrap:anywhere]", m.errorCode ? "text-[#f5a8a8]" : "text-ink", m.kind === "results" && "num text-[13px]")}>
        <Markdown text={m.text} />
      </div>
      {m.followUp && m.followUp !== m.text && <p className="border-l-2 border-accent pl-3 text-[13.5px] leading-5 text-ink">{m.followUp}</p>}
      {m.notices?.map((n) => (
        <p key={n} className="text-xs leading-4 text-warning">
          {n}
        </p>
      ))}
      {m.sources?.some((s) => OFFICIAL_SOURCE_URL.test(s.url)) && (
        <div className="text-xs leading-5 text-faint" data-testid="answer-sources">
          <span className="font-medium text-muted">Sources</span>
          <ul className="mt-0.5 space-y-0.5">
            {m.sources
              .filter((s) => OFFICIAL_SOURCE_URL.test(s.url))
              .map((s) => (
                <li key={s.url} className="[overflow-wrap:anywhere]">
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-muted underline decoration-line-strong underline-offset-2 hover:text-ink">
                    {s.label}
                  </a>{" "}
                  · retrieved {s.retrieved}
                </li>
              ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {m.errorCode && (
          <Button size="sm" onClick={() => dispatch({ type: "setMode", mode: "manual" })}>
            <SlidersHorizontal size={14} aria-hidden /> Use Manual Setup
          </Button>
        )}
        {m.suggestedAction === "run_analysis" && (
          <Button size="sm" onClick={() => runAnalysisNow(false)} disabled={running}>
            {running ? <Spinner /> : <Play size={14} aria-hidden />} Run analysis
          </Button>
        )}
        {m.suggestedAction === "open_results" && (
          <Button size="sm" onClick={() => dispatch({ type: "setMode", mode: "results" })}>
            <Gauge size={14} aria-hidden /> View results
          </Button>
        )}
        {m.analysisId &&
          (linkState === "missing" ? (
            <span className="text-xs text-faint">The linked saved analysis is no longer available.</span>
          ) : (
            <Button size="sm" onClick={() => (saved.unsavedEdits ? setConfirmOpen(true) : void openLinked())} disabled={linkState === "opening"}>
              <Archive size={14} aria-hidden /> Open saved analysis
            </Button>
          ))}
        {m.kind === "results" && canAsk && (
          <Button size="sm" variant="ghost" onClick={() => sendMessage("Explain the calculated differences and what limits the result.", { detail: true })}>
            Explain in detail
          </Button>
        )}
      </div>
      {proposal ? (
        <div className="lg:hidden">
          <ProposalPanel ps={proposal} />
        </div>
      ) : (
        m.proposalNote && <p className="text-xs leading-4 text-faint">{m.proposalNote}</p>
      )}
      <ConfirmDialog
        open={confirmOpen}
        title="Open the linked analysis?"
        description="Your workspace has changes that haven't been run and saved. Opening this analysis replaces them. Saved analyses are not affected."
        confirmLabel="Discard and open"
        tone="primary"
        onConfirm={() => void openLinked()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function CurrentConfig() {
  const { state, stale, dispatch, runAnalysisNow, running } = useApp();
  const stock = state.config.stock;
  const values = effectiveValues(state.config, "stock");
  const mod = state.config.modified ? effectiveValues(state.config, "modified") : null;
  const keys: SpecKey[] = ["peakPowerKw", "peakTorqueNm", "curbMassKg", "drivetrain"];
  const diff = modifiedDiff(state.config);
  return (
    <Panel title="Current configuration" subtitle="What the assistant sees. Changes apply only after you approve them.">
      {stock && values ? (
        <div className="space-y-3 text-[13px]">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-line bg-raised">
              <BrandGlyph make={stock.identity.make} size={22} />
            </div>
            <div className="min-w-0">
              <div className="font-medium text-ink">{vehicleLabel(stock.identity)}</div>
              <div className="text-xs text-faint">{stock.identity.sourceDetail}</div>
            </div>
          </div>
          <dl className="space-y-1.5">
            {keys.map((k) => (
              <div key={k} className="flex items-center justify-between gap-2">
                <dt className="text-muted">{SPEC_LABEL[k]}</dt>
                <dd className="flex items-center gap-1.5">
                  <span className="num text-ink">{displaySpec(k, values, state.ui.units)}</span>
                  <ProvenanceTag provenance={values[k].value == null ? "unavailable" : values[k].provenance} compact />
                </dd>
              </div>
            ))}
          </dl>
          {mod && (
            <div className="border-t border-line pt-2">
              <div className="mb-1 text-xs font-medium text-modified">Modified scenario</div>
              {diff.length ? (
                <ul className="space-y-1 text-xs text-muted">
                  {diff.map((k) => (
                    <li key={k} className="flex justify-between gap-2">
                      <span>{SPEC_LABEL[k]}</span>
                      <span className="num text-ink">{displaySpec(k, mod, state.ui.units)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-faint">Identical to stock.</p>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <Button size="sm" variant="primary" onClick={() => runAnalysisNow(false)} disabled={running}>
              {running ? <Spinner /> : <Play size={14} aria-hidden />} {state.result && stale ? "Re-run" : "Run analysis"}
            </Button>
            {state.result && (
              <Button size="sm" onClick={() => dispatch({ type: "setMode", mode: "results" })}>
                View results
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "setMode", mode: "manual" })}>
              Edit manually
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted">No vehicle yet. Name one in the chat (e.g. “2018 Honda Civic Si”) or pick it in Manual Setup.</p>
      )}
    </Panel>
  );
}

/** Saved analyses this conversation produced (by ID); deleted ones show as unavailable. */
function LinkedAnalyses() {
  const { state, saved } = useApp();
  const ids = state.chat.analysisIds;
  const [titles, setTitles] = useState<Record<string, string | null>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const key = `${ids.join(",")}|${state.saved.listRevision}`;
  useEffect(() => {
    if (!ids.length) return;
    let cancelled = false;
    getRepository()
      .list()
      .then(
        ({ items }) => !cancelled && setTitles(Object.fromEntries(ids.map((id) => [id, items.find((m) => m.id === id)?.title ?? null]))),
        () => undefined,
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key covers ids and list changes
  }, [key]);
  if (!ids.length) return null;
  return (
    <Panel title="Linked analyses" subtitle="Saved analyses produced in this conversation.">
      <ul className="space-y-2 text-[13px]">
        {ids.map((id) => (
          <li key={id} className="flex items-center justify-between gap-2">
            {titles[id] === null ? (
              <span className="text-faint">Deleted analysis (no longer available)</span>
            ) : (
              <>
                <span className="min-w-0 truncate text-ink">{titles[id] ?? "Saved analysis"}</span>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => (saved.unsavedEdits ? setConfirm(id) : void saved.open(id))}>
                  Open
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!confirm}
        title="Open the linked analysis?"
        description="Your workspace has changes that haven't been run and saved. Opening this analysis replaces them."
        confirmLabel="Discard and open"
        tone="primary"
        onConfirm={() => {
          if (confirm) void saved.open(confirm);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </Panel>
  );
}

/** A reopened chat about another vehicle: offer — never force — loading that vehicle. */
function ChatVehicleNotice() {
  const { state, dispatch, saved } = useApp();
  const [confirm, setConfirm] = useState(false);
  const v = state.chat.vehicle;
  const current = state.config.stock;
  if (!state.chat.restored || !v || (current && vehicleKey(current.identity) === vehicleKey(v.identity))) return null;
  const load = () => {
    setConfirm(false);
    dispatch({ type: "loadVehicle", specSet: v });
  };
  return (
    <div className="animate-fade flex flex-wrap items-center justify-between gap-2 border-b border-line bg-raised/50 px-4 py-2 text-xs text-muted sm:px-5" data-testid="chat-vehicle-notice">
      <span className="min-w-0">
        This chat was about <span className="text-ink">{vehicleLabel(v.identity)}</span>. {current ? `Your workspace has the ${vehicleLabel(current.identity)}.` : "No vehicle is loaded."}
      </span>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-accent" onClick={() => (saved.unsavedEdits ? setConfirm(true) : load())}>
        Load this vehicle
      </Button>
      <ConfirmDialog
        open={confirm}
        title="Replace the current vehicle?"
        description="Loading this chat's vehicle replaces your current configuration and its unsaved changes. Saved analyses are not affected."
        confirmLabel="Load vehicle"
        tone="primary"
        onConfirm={load}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}

const SUGGESTIONS: { category: string; text: string; icon: typeof Gauge; needsVehicle?: boolean }[] = [
  { category: "Vehicle comparisons", text: "Compare a C300 and M340i.", icon: Scale },
  { category: "Parts & mechanics", text: "How does a turbocharger work?", icon: Cog },
  { category: "Performance analysis", text: "How does losing 200 lb affect acceleration?", icon: Gauge },
  { category: "Current vehicle", text: "What are the biggest limitations of this build?", icon: CarFront, needsVehicle: true },
];

function ChatHeader({ onHistory, sidebarOpen, onRename }: { onHistory: (inline: boolean) => void; sidebarOpen: boolean; onRename: () => void }) {
  const { state, chat } = useApp();
  const c = state.chat;
  // The subject follow-ups refer to, derived locally from this conversation only.
  const subject = useMemo(
    () => describeTopic(deriveTopic(c.messages.filter((m) => !m.failed && !m.errorCode && m.kind !== "results" && (m.kind !== "local" || m.localKind === "clarify"))).topic),
    [c.messages],
  );
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2 sm:px-4">
      <Button size="sm" variant="ghost" className="h-8 px-2 xl:hidden" onClick={() => onHistory(false)} aria-label="Open chat history">
        <History size={16} aria-hidden /> <span className="hidden sm:inline">History</span>
      </Button>
      {!sidebarOpen && (
        <Button size="sm" variant="ghost" className="hidden h-8 px-2 xl:inline-flex" onClick={() => onHistory(true)} aria-label="Show chat history">
          <PanelLeftOpen size={16} aria-hidden />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        {c.id && c.messages.some((m) => m.kind !== "local" || m.localKind === "clarify" || m.localKind === "app_state") ? (
          <button type="button" onClick={onRename} className="group flex max-w-full items-center gap-1.5 rounded-sm text-left" aria-label={`Rename conversation: ${c.title}`}>
            <span key={c.id} className="animate-fade truncate text-[14px] font-medium text-ink">
              {c.title}
            </span>
            <Pencil size={12} aria-hidden className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        ) : (
          <span className="text-[14px] font-medium text-muted">New conversation</span>
        )}
        {subject && (
          <span className="block truncate text-[11px] text-faint" data-testid="chat-subject">
            Subject: {subject}
          </span>
        )}
        {c.storage.status === "error" ? (
          <span className="flex items-center gap-1.5 text-[11px] text-error" role="alert">
            Not saved: {c.storage.message}
            <button type="button" className="underline underline-offset-2" onClick={chat.retrySave}>
              Retry
            </button>
          </span>
        ) : c.storage.status === "memory" ? (
          <span className="text-[11px] text-warning">Browser storage unavailable — this chat is kept only until the tab closes.</span>
        ) : null}
      </div>
      <Button size="sm" variant="ghost" className="h-8 shrink-0 px-2" onClick={chat.newChat} disabled={!c.messages.length} aria-label="New chat">
        <MessageSquarePlus size={16} aria-hidden /> <span className="hidden sm:inline">New chat</span>
      </Button>
    </div>
  );
}

const SIDEBAR_KEY = "autodyn:chat:sidebar";
const subscribeNone = () => () => {};

export default function AssistantWorkspace() {
  const { state, aiStatus, sendMessage, checkConnection, running, chat } = useApp();
  const [text, setText] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [sidebarPref, setSidebarPref] = useState<boolean | null>(null);
  const storedPref = useSyncExternalStore(
    subscribeNone,
    () => {
      try {
        return window.localStorage.getItem(SIDEBAR_KEY);
      } catch {
        return null;
      }
    },
    () => null,
  );
  const sidebarOpen = sidebarPref ?? storedPref !== "closed";
  const setSidebar = (open: boolean) => {
    setSidebarPref(open);
    try {
      window.localStorage.setItem(SIDEBAR_KEY, open ? "open" : "closed");
    } catch {
      // ignore
    }
  };
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { messages, pending, proposals } = state.chat;
  const blocked = aiStatus.phase === "unavailable" || (aiStatus.phase === "checking" && !aiStatus.deployment);
  const cooling = !!chat.cooldownUntil && chat.cooldownUntil > now;
  const full = messages.length >= MAX_CONVERSATION_MESSAGES - 2;
  const active = Object.values(proposals).find((p) => p.status === "pending") ?? null;
  const lastProposal = active ?? Object.values(proposals).at(-1) ?? null;
  const make = state.config.stock?.identity.make ?? null;
  const omitted = omittedCount(messages);

  // Verify the live provider once per browser session when the assistant is first opened.
  useEffect(() => {
    if (aiStatus.phase !== "untested") return;
    try {
      if (window.sessionStorage.getItem(PROBED_KEY)) return;
      window.sessionStorage.setItem(PROBED_KEY, "1");
    } catch {
      // Storage unavailable: still probe once for this mount.
    }
    checkConnection();
  }, [aiStatus.phase, checkConnection]);

  useEffect(() => {
    if (!chat.cooldownUntil) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [chat.cooldownUntil]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending, running, state.chat.view]);

  const submit = () => {
    if (!text.trim() || pending || blocked || cooling || full || text.length > AI_LIMITS.maxMessageChars) return;
    sendMessage(text);
    setText("");
  };

  return (
    <div className={cx("grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]", sidebarOpen && "xl:grid-cols-[240px_minmax(0,1fr)_340px]")}>
      {sidebarOpen && (
        <aside className="animate-fade hidden min-h-0 flex-col rounded-lg border border-line bg-surface xl:sticky xl:top-[132px] xl:flex xl:h-[calc(100dvh-200px)] xl:self-start" aria-label="Chat history">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-[13px] font-semibold tracking-tight">Chat history</h2>
            <Button size="sm" variant="ghost" className="h-7 w-7 px-0" onClick={() => setSidebar(false)} aria-label="Hide chat history">
              <PanelLeftClose size={15} aria-hidden />
            </Button>
          </div>
          <ChatHistory />
        </aside>
      )}
      <Dialog open={drawer} title="Chat history" onClose={() => setDrawer(false)} variant="drawer">
        <ChatHistory onNavigate={() => setDrawer(false)} />
      </Dialog>

      <div className="flex min-h-[520px] min-w-0 flex-col rounded-lg border border-line bg-surface lg:h-[calc(100dvh-200px)]">
        <ConnectionBar />
        <ChatHeader onHistory={(inline) => (inline ? setSidebar(true) : setDrawer(true))} sidebarOpen={sidebarOpen} onRename={() => setRenaming(true)} />
        <ChatVehicleNotice />

        <div ref={listRef} key={state.chat.view} className="animate-fade scrollbar-thin flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite" data-testid="chat-log">
          {messages.length === 0 ? (
            <div className="mx-auto max-w-xl py-2">
              <h2 className="text-[15px] font-semibold">Ask about cars, parts or your build</h2>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                Automotive questions get a direct answer. For analyses, the assistant finds vehicles in AutoDyn&apos;s data and turns your request into changes you review and approve —
                the physics engine computes every number.
              </p>
              {state.config.stock && <p className="mt-2 text-xs text-faint">Active vehicle: {vehicleLabel(state.config.stock.identity)} — a new chat keeps your current configuration.</p>}
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.filter((s) => !s.needsVehicle || state.config.stock).map((s) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.text}
                      type="button"
                      disabled={blocked}
                      onClick={() => {
                        setText(s.text);
                        inputRef.current?.focus();
                      }}
                      className="group rounded-md border border-line px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-raised disabled:opacity-40"
                    >
                      <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">
                        <Icon size={13} aria-hidden className="text-accent" /> {s.category}
                      </span>
                      <span className="mt-1 block text-[13px] leading-5 text-muted group-hover:text-ink">{s.text}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-4 text-[11.5px] leading-4 text-faint">
                The assistant only discusses automotive topics; other questions are answered locally without using the AI. Chats are saved in this browser; messages you send are
                processed by Google Gemini.
              </p>
            </div>
          ) : (
            messages.map((m) => <Message key={m.id} m={m} proposal={m.proposalId ? proposals[m.proposalId] : undefined} />)
          )}
          {pending && <LoadingStage make={make} label="Thinking about your question" compact />}
          {running && !pending && <LoadingStage make={make} label="Running the physics simulation" compact />}
        </div>

        <form
          className="border-t border-line p-3 sm:p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {(cooling || full) && (
            <p className="mb-2 text-xs text-warning" role="status">
              {full
                ? "This conversation has reached its length limit. Start a new chat to continue."
                : `Paused after a rate limit — you can send again in ${Math.ceil((chat.cooldownUntil! - now) / 1000)} s.`}
            </p>
          )}
          <label htmlFor="chat-input" className="sr-only">
            Message the AI Build Assistant
          </label>
          <div className="flex items-end gap-2 rounded-md border border-line bg-bg px-3 py-2 focus-within:border-accent">
            <textarea
              id="chat-input"
              ref={inputRef}
              rows={1}
              value={text}
              maxLength={AI_LIMITS.maxMessageChars + 200}
              disabled={blocked || full}
              placeholder={
                blocked ? "Assistant unavailable — use Manual Setup" : state.config.stock ? `Ask about the ${state.config.stock.identity.model}, a part, or a change…` : "Ask about a car, a part, or a build…"
              }
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="field-sizing-content max-h-36 min-h-[24px] flex-1 resize-none bg-transparent text-[15px] leading-6 text-ink outline-none placeholder:text-faint sm:text-[14px]"
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Send message"
              disabled={!text.trim() || !!pending || blocked || cooling || full || text.length > AI_LIMITS.maxMessageChars}
            >
              <ArrowUp size={16} aria-hidden />
            </Button>
          </div>
          <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-[11px] text-faint">
            <span className="hidden sm:inline">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
            </span>
            {omitted > 0 && <span>The assistant sees the latest messages only ({omitted} earlier not sent).</span>}
            <span className={cx("num ml-auto", text.length > AI_LIMITS.maxMessageChars && "text-error")}>
              {text.length}/{AI_LIMITS.maxMessageChars}
            </span>
          </div>
        </form>
      </div>

      <aside className="min-w-0 space-y-4 lg:sticky lg:top-[132px] lg:self-start">
        {lastProposal && (
          <div className="hidden lg:block">
            <ProposalPanel key={lastProposal.proposal.id} ps={lastProposal} />
          </div>
        )}
        <CurrentConfig />
        <LinkedAnalyses />
      </aside>

      <PromptDialog
        open={renaming}
        title="Rename conversation"
        label="Conversation title"
        initial={state.chat.title}
        confirmLabel="Rename"
        onSubmit={async (title) => {
          setRenaming(false);
          if (state.chat.id) await chat.rename(state.chat.id, title);
        }}
        onCancel={() => setRenaming(false)}
      />
    </div>
  );
}
