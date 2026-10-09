"use client";

import { Gauge, SlidersHorizontal, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import AssistantWorkspace from "@/components/assistant/AssistantWorkspace";
import ManualSetup from "@/components/manual/ManualSetup";
import { cx, ProvenanceTag, Segmented, Spinner } from "@/components/ui";
import { modifiedDiff } from "@/lib/domain/scenario";
import { vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp } from "@/state/AppProvider";
import type { Mode } from "@/state/reducer";

// Charts are only needed in the Results workspace; load them on demand.
const ResultsWorkspace = dynamic(() => import("@/components/results/ResultsWorkspace"), {
  loading: () => (
    <div className="flex items-center gap-2 py-10 text-sm text-muted">
      <Spinner /> Loading results workspace…
    </div>
  ),
});

const MODES: { id: Mode; label: string; short: string; description: string; icon: typeof Gauge }[] = [
  { id: "manual", label: "Manual Setup", short: "Manual", description: "Choose a vehicle, adjust its specifications, and run your own analysis.", icon: SlidersHorizontal },
  { id: "assistant", label: "AI Build Assistant", short: "Assistant", description: "Describe a vehicle or build and let AutoDyn help configure the analysis.", icon: Sparkles },
  { id: "results", label: "Results", short: "Results", description: "Shared engineering analysis for both setup modes.", icon: Gauge },
];

function ResultStatus() {
  const { state, stale, running } = useApp();
  if (running) return <span className="text-[11px] text-accent">Running…</span>;
  if (!state.result) return <span className="text-[11px] text-faint">Not run</span>;
  return stale ? <span className="text-[11px] text-caution">Out of date</span> : <span className="text-[11px] text-gain">Up to date</span>;
}

function VehicleStrip() {
  const { state, stale } = useApp();
  const stock = state.config.stock;
  const changes = modifiedDiff(state.config).length;
  return (
    <div className="no-print border-b border-line bg-surface/60">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 text-[13px] sm:px-6">
        <span className="text-faint">Vehicle</span>
        {stock ? (
          <span className="min-w-0 truncate font-medium text-ink">{vehicleLabel(stock.identity)}</span>
        ) : (
          <span className="text-muted">None selected</span>
        )}
        {stock && (
          <ProvenanceTag
            provenance={stock.identity.source === "custom" ? "user" : "verified"}
            title={stock.identity.sourceDetail}
          />
        )}
        <span className="hidden h-4 w-px bg-line sm:block" />
        <span className="text-faint">Scenarios</span>
        <span className="text-muted">
          Stock{state.config.modified ? <> · <span className="text-accent">Modified</span> ({changes} change{changes === 1 ? "" : "s"})</> : null}
        </span>
        {state.result && stale && (
          <>
            <span className="hidden h-4 w-px bg-line sm:block" />
            <span className="text-caution">Inputs changed since the last analysis</span>
          </>
        )}
      </div>
    </div>
  );
}

export default function AppShell() {
  const { state, dispatch } = useApp();
  const mode = state.ui.mode;

  return (
    <div className="min-h-dvh">
      <header className="no-print sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur-[2px]">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 pt-3 sm:px-6">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[17px] font-semibold tracking-tight">
              Auto<span className="text-accent">Dyn</span>
            </span>
            <span className="hidden text-xs text-faint sm:inline">Performance Lab</span>
          </div>
          <Segmented
            label="Display units"
            size="sm"
            value={state.ui.units}
            onChange={(units) => dispatch({ type: "setUnits", units })}
            options={[
              { value: "imperial", label: "Imperial" },
              { value: "metric", label: "Metric" },
            ]}
          />
        </div>
        <nav aria-label="Workspace" className="mx-auto mt-2 max-w-[1400px] px-2 sm:px-4">
          <div
            role="tablist"
            className="grid grid-cols-3 sm:flex sm:gap-1"
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const i = MODES.findIndex((m) => m.id === mode);
              const next = MODES[(i + (e.key === "ArrowRight" ? 1 : MODES.length - 1)) % MODES.length];
              dispatch({ type: "setMode", mode: next.id });
              (e.currentTarget.querySelector(`[data-mode="${next.id}"]`) as HTMLButtonElement | null)?.focus();
            }}
          >
            {MODES.map((m) => {
              const Icon = m.icon;
              const active = mode === m.id;
              return (
                <button
                  key={m.id}
                  role="tab"
                  type="button"
                  aria-selected={active}
                  aria-controls="workspace"
                  tabIndex={active ? 0 : -1}
                  data-mode={m.id}
                  onClick={() => dispatch({ type: "setMode", mode: m.id })}
                  title={m.description}
                  className={cx(
                    "group relative flex min-w-0 items-center justify-center gap-2 px-2 pt-2 pb-2.5 text-[13px] font-medium transition-colors sm:justify-start sm:px-3 sm:text-sm",
                    active ? "text-ink" : "text-muted hover:text-ink",
                  )}
                >
                  <Icon size={16} strokeWidth={1.75} className={active ? "text-accent" : "text-faint group-hover:text-muted"} aria-hidden />
                  <span className="truncate sm:hidden">{m.short}</span>
                  <span className="hidden sm:inline">{m.label}</span>
                  {m.id === "results" && (
                    <span className="hidden md:inline">
                      <ResultStatus />
                    </span>
                  )}
                  <span
                    aria-hidden
                    className={cx(
                      "absolute inset-x-2 bottom-0 h-[2px] origin-center bg-accent transition-transform duration-200",
                      active ? "scale-x-100" : "scale-x-0",
                    )}
                  />
                </button>
              );
            })}
          </div>
        </nav>
      </header>
      <VehicleStrip />
      <main id="workspace" className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 sm:py-6">
        {mode !== "results" && (
          <p className="no-print mb-4 max-w-2xl text-[13px] leading-5 text-muted">{MODES.find((m) => m.id === mode)?.description}</p>
        )}
        <div key={mode} role="tabpanel" aria-label={MODES.find((m) => m.id === mode)?.label} className="animate-enter">
          {mode === "manual" && <ManualSetup />}
          {mode === "assistant" && <AssistantWorkspace />}
          {mode === "results" && <ResultsWorkspace />}
        </div>
      </main>
      <footer className="no-print mx-auto max-w-[1400px] px-4 pb-8 text-xs leading-5 text-faint sm:px-6">
        Theoretical estimates from a deterministic physics model. Not a guarantee of real-world performance and not guidance for driving at speed.
        Specifications: CarAPI dataset (2015–2020) and NHTSA vPIC identification.
      </footer>
    </div>
  );
}
