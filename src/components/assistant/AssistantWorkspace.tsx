"use client";

import { ArrowUp, Gauge, Play, PlugZap, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ProposalPanel from "@/components/assistant/ProposalPanel";
import LoadingStage, { BrandGlyph } from "@/components/LoadingStage";
import { Button, cx, Kbd, Panel, ProvenanceTag, Spinner } from "@/components/ui";
import { displaySpec } from "@/lib/ai/context";
import { AI_LIMITS, AI_UNAVAILABLE_MESSAGE, isBlocking, PROVIDER_MESSAGES } from "@/lib/ai/types";
import { SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveValues, modifiedDiff } from "@/lib/domain/scenario";
import type { SpecKey } from "@/lib/domain/types";
import { vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp, type AiStatus } from "@/state/AppProvider";
import type { ChatMessage, ProposalState } from "@/state/reducer";

const EXAMPLES = [
  "Compare a stock 2015 Mercedes-Benz C300 with 40 extra horsepower.",
  "Analyze a stock 2018 Ford Mustang GT.",
  "What would change if this car weighed 150 pounds less?",
  "Compare the effects of additional power versus reduced weight.",
  "Which assumptions have the biggest impact on the result?",
  "Explain why the modified version accelerates differently.",
];

const PROBED_KEY = "autodyn:ai-probed";

/** Renders untrusted model text as plain paragraphs and bullet lists (never as HTML). */
function PlainText({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {text.split(/\n{2,}/).map((b, i) => {
        const lines = b.split("\n").filter((l) => l.trim());
        const bullets = lines.filter((l) => /^\s*[-•*]\s+/.test(l));
        if (bullets.length && bullets.length >= lines.length - 1) {
          const head = lines.length > bullets.length ? lines[0] : null;
          return (
            <div key={i}>
              {head && <p>{head}</p>}
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {bullets.map((l, j) => (
                  <li key={j}>{l.replace(/^\s*[-•*]\s+/, "")}</li>
                ))}
              </ul>
            </div>
          );
        }
        return (
          <p key={i} className="whitespace-pre-line">
            {b}
          </p>
        );
      })}
    </div>
  );
}

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
  const { dispatch, runAnalysisNow, running, sendMessage, state, aiStatus } = useApp();
  if (m.role === "user") {
    return (
      <div className="animate-enter flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-line bg-raised px-3.5 py-2.5 text-[14px] leading-6 whitespace-pre-line text-ink [overflow-wrap:anywhere]">{m.text}</div>
      </div>
    );
  }
  const canAsk = !state.chat.pending && !isBlocking(aiStatus.code ?? undefined);
  return (
    <div className="animate-enter max-w-[92%] space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-faint uppercase">
        {m.kind === "results" ? "Physics engine" : "AutoDyn assistant"}
        {m.kind === "results" && <ProvenanceTag provenance="verified" title="Computed deterministically — not AI-generated" />}
      </div>
      <div className={cx("text-[14px] leading-6 [overflow-wrap:anywhere]", m.errorCode ? "text-[#f5a8a8]" : "text-ink", m.kind === "results" && "num text-[13px]")}>
        <PlainText text={m.text} />
      </div>
      {m.followUp && m.followUp !== m.text && <p className="border-l-2 border-accent pl-3 text-[13.5px] leading-5 text-ink">{m.followUp}</p>}
      {m.notices?.map((n) => (
        <p key={n} className="text-xs leading-4 text-warning">
          {n}
        </p>
      ))}
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
        {m.kind === "results" && canAsk && (
          <Button size="sm" variant="ghost" onClick={() => sendMessage("Explain the calculated differences and what limits the result.", { detail: true })}>
            Explain in detail
          </Button>
        )}
      </div>
      {proposal && (
        <div className="lg:hidden">
          <ProposalPanel ps={proposal} />
        </div>
      )}
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

export default function AssistantWorkspace() {
  const { state, dispatch, aiStatus, sendMessage, checkConnection, running } = useApp();
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const { messages, pending, proposals } = state.chat;
  const blocked = aiStatus.phase === "unavailable" || (aiStatus.phase === "checking" && !aiStatus.deployment);
  const active = Object.values(proposals).find((p) => p.status === "pending") ?? null;
  const lastProposal = active ?? Object.values(proposals).at(-1) ?? null;
  const make = state.config.stock?.identity.make ?? null;

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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending, running]);

  const submit = () => {
    if (!text.trim() || pending || blocked || text.length > AI_LIMITS.maxMessageChars) return;
    sendMessage(text);
    setText("");
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-h-[520px] min-w-0 flex-col rounded-lg border border-line bg-surface lg:h-[calc(100dvh-200px)]">
        <ConnectionBar />
        <div className="flex items-center justify-between gap-2 px-4 pt-2 sm:px-5">
          <span className="text-xs text-faint">The assistant interprets and explains · the physics engine computes every number</span>
          {messages.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "chatClear" })} disabled={!!pending}>
              <Trash2 size={14} aria-hidden /> Clear
            </Button>
          )}
        </div>

        <div ref={listRef} className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
          {messages.length === 0 ? (
            <div className="mx-auto max-w-xl py-4">
              <h2 className="text-[15px] font-semibold">Describe a vehicle or a build</h2>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                The assistant finds vehicles in AutoDyn&apos;s data, turns your request into changes you review and approve, and explains computed results. It never invents
                specifications or performance numbers.
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {EXAMPLES.map((e) => (
                  <button
                    key={e}
                    type="button"
                    disabled={blocked || !!pending}
                    onClick={() => sendMessage(e)}
                    className="rounded-md border border-line px-3 py-2.5 text-left text-[13px] leading-5 text-muted transition-colors hover:border-line-strong hover:bg-raised hover:text-ink disabled:opacity-40"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <Message key={m.id} m={m} proposal={m.proposalId ? proposals[m.proposalId] : undefined} />)
          )}
          {pending && <LoadingStage make={make} label="Interpreting your request" compact />}
          {running && !pending && <LoadingStage make={make} label="Running the physics simulation" compact />}
        </div>

        <form
          className="border-t border-line p-3 sm:p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="chat-input" className="sr-only">
            Message the AI Build Assistant
          </label>
          <div className="flex items-end gap-2 rounded-md border border-line bg-bg px-3 py-2 focus-within:border-accent">
            <textarea
              id="chat-input"
              rows={1}
              value={text}
              maxLength={AI_LIMITS.maxMessageChars + 200}
              disabled={blocked}
              placeholder={blocked ? "Assistant unavailable — use Manual Setup" : state.config.stock ? `Ask about the ${state.config.stock.identity.model}, or describe a change…` : "e.g. Compare a stock 2015 C300 with 40 more hp"}
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
              disabled={!text.trim() || !!pending || blocked || text.length > AI_LIMITS.maxMessageChars}
            >
              <ArrowUp size={16} aria-hidden />
            </Button>
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-faint">
            <span className="hidden sm:inline">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
            </span>
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
      </aside>
    </div>
  );
}
