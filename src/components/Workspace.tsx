"use client";

// Workspace-level controls shared by Manual Setup, Results and the app shell: New Analysis,
// the previous-session offer, and the automatic-save indicator.

import { FilePlus2, History, RotateCcw } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/Dialog";
import { Button, Notice, Spinner } from "@/components/ui";
import { vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp } from "@/state/AppProvider";

export function NewAnalysisButton({ className }: { className?: string }) {
  const { state, saved } = useApp();
  const [confirm, setConfirm] = useState(false);
  const active = state.saved.active;
  const start = () => (saved.unsavedEdits ? setConfirm(true) : saved.newAnalysis());
  return (
    <>
      <Button size="sm" className={className} onClick={start} data-testid="new-analysis">
        <FilePlus2 size={14} aria-hidden /> New Analysis
      </Button>
      <ConfirmDialog
        open={confirm}
        title="Start a new analysis?"
        description={
          active
            ? `Changes made since “${active.title}” was last run will be discarded. Saved analyses are not affected.`
            : "This configuration hasn't been run, so it isn't in Saved Analyses yet. It will be discarded. Saved analyses are not affected."
        }
        confirmLabel="Discard and start new"
        onConfirm={() => {
          setConfirm(false);
          saved.newAnalysis();
        }}
        onCancel={() => setConfirm(false)}
      />
    </>
  );
}

export function DraftOffer() {
  const { state, saved } = useApp();
  const d = state.draftOffer;
  if (!d || !d.config.stock) return null;
  const when = d.savedAt ? new Date(d.savedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <section aria-label="Previous session" className="no-print animate-enter border-b border-line bg-raised/60">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <p className="min-w-0 text-[13px] leading-5 text-muted">
          <History size={14} aria-hidden className="mr-1.5 inline-block align-[-2px] text-accent" />
          <span className="text-ink">Continue where you left off?</span> {vehicleLabel(d.config.stock.identity)} · {d.config.modified ? "Stock vs Modified" : "Stock"}
          {when ? ` · last edited ${when}` : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => void saved.continueDraft()}>
            Continue last session
          </Button>
          <Button size="sm" variant="ghost" onClick={saved.discardDraft}>
            Start fresh
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Where the current result lives: "Saved as …", saving, or a recoverable storage error. */
export function SaveIndicator() {
  const { state, dispatch, saved } = useApp();
  const s = state.saved;
  if (!state.result) return null;
  if (s.status === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-faint">
        <Spinner label="Saving" /> Saving…
      </span>
    );
  }
  if (s.status === "error") {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-error" role="alert">
        Not saved: {s.error}
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-error" onClick={saved.retrySave}>
          <RotateCcw size={12} aria-hidden /> Retry
        </Button>
      </span>
    );
  }
  if (!s.active) return null;
  return (
    <span className="min-w-0 truncate text-faint">
      Saved as{" "}
      <button type="button" className="text-muted underline decoration-line-strong underline-offset-2 hover:text-ink" onClick={() => dispatch({ type: "setMode", mode: "saved" })}>
        {s.active.title}
      </button>
    </span>
  );
}

/** Values reset while continuing a previous session (physically invalid, e.g. a 1 lb weight). */
export function RestoredFixes() {
  const { state, dispatch } = useApp();
  if (!state.restoredFixes.length) return null;
  const n = state.restoredFixes.length;
  return (
    <Notice
      tone="warning"
      action={
        <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "dismissRestored" })}>
          Dismiss
        </Button>
      }
    >
      {n} saved value{n > 1 ? "s were" : " was"} physically invalid and reset to the source data: {state.restoredFixes.join(", ")}.
    </Notice>
  );
}
