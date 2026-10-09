"use client";

import { ArrowUp, Gauge, Play, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ProposalPanel from "@/components/assistant/ProposalPanel";
import { Button, cx, Kbd, Notice, Panel, ProvenanceTag, Spinner } from "@/components/ui";
import { displaySpec } from "@/lib/ai/context";
import { AI_LIMITS, AI_UNAVAILABLE_MESSAGE } from "@/lib/ai/types";
import { SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveValues, modifiedDiff } from "@/lib/domain/scenario";
import type { SpecKey } from "@/lib/domain/types";
import { vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp } from "@/state/AppProvider";
import type { ChatMessage, ProposalState } from "@/state/reducer";

const EXAMPLES = [
  "Analyze a stock 2015 Mercedes-Benz C300.",
  "Compare my current vehicle with a version producing 40 more horsepower.",
  "What would change if this car weighed 150 pounds less?",
  "Explain why the modified version accelerates differently.",
  "Compare the effects of additional power versus reduced weight.",
  "Show me which assumptions have the biggest impact on the result.",
];

/** Renders untrusted model text as plain paragraphs and bullet lists (never as HTML). */
function PlainText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const lines = b.split("\n").filter((l) => l.trim());
        if (lines.length && lines.every((l) => /^\s*[-•*]\s+/.test(l))) {
          return (
            <ul key={i} className="list-disc space-y-1 pl-4">
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*[-•*]\s+/, "")}</li>
              ))}
            </ul>
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

function Message({ m, proposal }: { m: ChatMessage; proposal?: ProposalState }) {
  const { dispatch, runAnalysisNow, running } = useApp();
  if (m.role === "user") {
    return (
      <div className="animate-enter flex justify-end">
        <div className="max-w-[85%] rounded-lg border border-line bg-raised px-3.5 py-2.5 text-[14px] leading-6 whitespace-pre-line text-ink">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="animate-enter max-w-[92%] space-y-2">
      <div className="text-[11px] font-medium tracking-wide text-faint uppercase">AutoDyn assistant</div>
      <div className={cx("text-[14px] leading-6", m.errorCode ? "text-[#f0b2aa]" : "text-ink")}>
        <PlainText text={m.text} />
      </div>
      {m.followUp && m.followUp !== m.text && <p className="border-l-2 border-accent pl-3 text-[13.5px] leading-5 text-ink">{m.followUp}</p>}
      {m.notices?.map((n) => (
        <p key={n} className="text-xs leading-4 text-caution">
          {n}
        </p>
      ))}
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
  const keys: SpecKey[] = ["peakPowerKw", "peakTorqueNm", "curbMassKg", "drivetrain", "transmission"];
  const diff = modifiedDiff(state.config);
  return (
    <Panel title="Current configuration" subtitle="What the assistant sees. Changes apply only after you approve them.">
      {stock && values ? (
        <div className="space-y-3 text-[13px]">
          <div>
            <div className="font-medium text-ink">{vehicleLabel(stock.identity)}</div>
            <div className="text-xs text-faint">{stock.identity.sourceDetail}</div>
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
              <div className="mb-1 text-xs font-medium text-accent">Modified scenario</div>
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
          {state.result && <p className="text-xs text-faint">{stale ? "Results are out of date." : "Results match this configuration."}</p>}
        </div>
      ) : (
        <p className="text-[13px] text-muted">No vehicle yet. Name one in the chat (e.g. “2018 Honda Civic Si”) or pick it in Manual Setup.</p>
      )}
    </Panel>
  );
}

export default function AssistantWorkspace() {
  const { state, dispatch, aiStatus, sendMessage } = useApp();
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const { messages, pending, proposals } = state.chat;
  const unavailable = aiStatus === "unavailable";
  const active = Object.values(proposals).find((p) => p.status === "pending") ?? null;
  const lastProposal = active ?? Object.values(proposals).at(-1) ?? null;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending]);

  const submit = () => {
    if (!text.trim() || pending || unavailable || text.length > AI_LIMITS.maxMessageChars) return;
    sendMessage(text);
    setText("");
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-h-[560px] min-w-0 flex-col rounded-lg border border-line bg-surface lg:h-[calc(100dvh-200px)]">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 sm:px-5">
          <span className="text-[13px] text-muted">
            {aiStatus === "checking" ? "Checking assistant availability…" : unavailable ? "Assistant offline" : "Interprets requests · physics engine computes results"}
          </span>
          {messages.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "chatClear" })} disabled={!!pending}>
              <Trash2 size={14} aria-hidden /> Clear
            </Button>
          )}
        </div>

        {unavailable && (
          <div className="px-4 pt-3 sm:px-5">
            <Notice
              tone="warning"
              action={
                <Button size="sm" onClick={() => dispatch({ type: "setMode", mode: "manual" })}>
                  Open Manual Setup
                </Button>
              }
            >
              {AI_UNAVAILABLE_MESSAGE}
            </Notice>
          </div>
        )}

        <div ref={listRef} className="scrollbar-thin flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
          {messages.length === 0 ? (
            <div className="mx-auto max-w-xl py-6">
              <h2 className="text-[15px] font-semibold">Describe a vehicle or a build</h2>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                The assistant identifies vehicles from AutoDyn&apos;s data, turns your request into proposed inputs for review, and explains computed results. It never invents
                specifications or performance numbers.
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {EXAMPLES.map((e) => (
                  <button
                    key={e}
                    type="button"
                    disabled={unavailable || !!pending}
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
          {pending && (
            <div className="flex items-center gap-2 text-[13px] text-muted">
              <Spinner label="Assistant is responding" /> Interpreting request…
            </div>
          )}
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
              disabled={unavailable}
              placeholder={unavailable ? "Assistant unavailable" : state.config.stock ? `Ask about the ${state.config.stock.identity.model}, or describe a change…` : "e.g. Analyze a stock 2019 Ford Mustang GT"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="max-h-36 min-h-[24px] flex-1 resize-none bg-transparent text-[14px] leading-6 text-ink outline-none placeholder:text-faint field-sizing-content"
            />
            <Button type="submit" variant="primary" size="sm" className="h-8 w-8 px-0" aria-label="Send message" disabled={!text.trim() || !!pending || unavailable || text.length > AI_LIMITS.maxMessageChars}>
              <ArrowUp size={16} aria-hidden />
            </Button>
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-faint">
            <span>
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line
            </span>
            <span className={cx("num", text.length > AI_LIMITS.maxMessageChars && "text-loss")}>
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
