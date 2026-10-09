"use client";

import { Play, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import SpecEditor from "@/components/manual/SpecEditor";
import VehicleSelector from "@/components/manual/VehicleSelector";
import { Button, cx, Notice, Panel, Segmented, Spinner } from "@/components/ui";
import { NUMERIC_FIELDS, SPEC_LABEL } from "@/lib/domain/fields";
import { modifiedDiff } from "@/lib/domain/scenario";
import type { NumericSpecKey } from "@/lib/domain/types";
import { validateConfig, type Fix, type Issue } from "@/lib/domain/validation";
import { toDisplay, unitLabel } from "@/lib/units";
import { useApp } from "@/state/AppProvider";

export function useValidation() {
  const { state } = useApp();
  return useMemo(() => validateConfig(state.config), [state.config]);
}

function FixButton({ issue, fix }: { issue: Issue; fix: Fix }) {
  const { state, dispatch } = useApp();
  const def = NUMERIC_FIELDS[fix.key as NumericSpecKey];
  const display = def ? `${toDisplay(def.quantity, fix.value, state.ui.units).toFixed(0)} ${unitLabel(def.quantity, state.ui.units)}` : String(fix.value);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-xs text-accent"
      onClick={() =>
        dispatch({
          type: issue.scenario === "modified" ? "setModifiedValue" : "setStockValue",
          key: fix.key,
          value: { value: fix.value, provenance: "user", source: "User-confirmed adjustment", note: fix.label } as never,
        })
      }
    >
      {fix.label} ({display})
    </Button>
  );
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="space-y-2">
      {issues.map((i) => (
        <li key={i.id} className="text-[12.5px] leading-5">
          <span className={i.severity === "error" ? "text-loss" : "text-caution"}>
            {i.scenario === "conditions" ? "Conditions" : i.scenario === "modified" ? "Modified" : "Stock"}
            {i.key && i.scenario !== "conditions" ? ` · ${SPEC_LABEL[i.key as keyof typeof SPEC_LABEL] ?? i.key}` : ""}:
          </span>{" "}
          <span className="text-muted">{i.message}</span>
          {i.fixes?.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {i.fixes.map((f) => (
                <FixButton key={`${f.key}-${f.label}`} issue={i} fix={f} />
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RunPanel() {
  const { state, dispatch, running, runAnalysisNow, stale } = useApp();
  const v = useValidation();
  const warningsAcked = state.ui.ackRevision === state.revision;
  const blocked = v.errors > 0 || (v.warnings > 0 && !warningsAcked);
  const changes = modifiedDiff(state.config);
  const result = state.result?.analysis;

  return (
    <div className="space-y-4 lg:sticky lg:top-[132px]">
      <Panel title="Run analysis" subtitle={state.config.modified ? "Stock vs. Modified comparison" : "Stock scenario only"}>
        <div className="space-y-3">
          {v.errors > 0 && <p className="text-[13px] text-loss">{v.errors} issue{v.errors > 1 ? "s" : ""} must be resolved before simulating.</p>}
          <IssueList issues={v.issues} />
          {v.warnings > 0 && v.errors === 0 && (
            <label className="flex items-start gap-2 rounded-md border border-caution/30 bg-caution/5 px-3 py-2 text-[12.5px] leading-5 text-[#e9cf98]">
              <input
                type="checkbox"
                checked={warningsAcked}
                onChange={() => dispatch({ type: "ackWarnings" })}
                disabled={warningsAcked}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              I&apos;ve reviewed these unusual values and want to simulate them as entered.
            </label>
          )}
          <Button variant="primary" className="w-full" disabled={blocked || running} onClick={() => runAnalysisNow(true)}>
            {running ? <Spinner label="Running analysis" /> : <Play size={15} aria-hidden />}
            {running ? "Simulating…" : state.result && stale ? "Re-run analysis" : "Run analysis"}
          </Button>
          <p className="text-[11.5px] leading-4 text-faint">Runs the deterministic physics engine in your browser. No AI is involved in the calculation.</p>
        </div>
      </Panel>

      {state.config.modified && (
        <Panel title="Modified scenario" subtitle={`${changes.length} parameter${changes.length === 1 ? "" : "s"} differ from stock`}>
          {changes.length ? (
            <ul className="space-y-1 text-[12.5px] text-muted">
              {changes.map((k) => (
                <li key={k} className="flex justify-between gap-2">
                  <span>{SPEC_LABEL[k]}</span>
                  <span className="text-accent">changed</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted">Identical to stock. Edit values in the Modified scenario to compare.</p>
          )}
        </Panel>
      )}

      {result && (
        <Panel title="Latest result" subtitle={stale ? "Out of date — inputs changed" : "Matches current inputs"}>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <dt className="text-xs text-faint">Stock 0–60 mph</dt>
              <dd className="num text-lg">{result.stock.metrics.zeroTo60S?.toFixed(2) ?? "—"} s</dd>
            </div>
            {result.modified && (
              <div>
                <dt className="text-xs text-faint">Modified 0–60 mph</dt>
                <dd className="num text-lg text-accent">{result.modified.metrics.zeroTo60S?.toFixed(2) ?? "—"} s</dd>
              </div>
            )}
          </dl>
          <Button size="sm" className="mt-3" onClick={() => dispatch({ type: "setMode", mode: "results" })}>
            View results
          </Button>
        </Panel>
      )}
    </div>
  );
}

export default function ManualSetup() {
  const { state, dispatch } = useApp();
  const v = useValidation();
  const stock = state.config.stock;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <Panel
          title="Vehicle"
          subtitle="Pick a vehicle from the specification dataset, decode a VIN, or define a custom vehicle."
          actions={
            stock && (
              <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "clearVehicle" })}>
                Start over
              </Button>
            )
          }
        >
          <VehicleSelector />
        </Panel>

        {stock ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs font-medium text-muted">Editing scenario</span>
                <Segmented
                  label="Scenario being edited"
                  value={state.ui.editing}
                  onChange={(s) => dispatch({ type: "setEditing", scenario: s })}
                  options={[
                    { value: "stock", label: "Stock" },
                    { value: "modified", label: "Modified", disabled: !state.config.modified, title: state.config.modified ? undefined : "Create the modified scenario first" },
                  ]}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {state.ui.editing === "stock" && state.baseline && (
                  <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "resetStock" })}>
                    Reset stock to source data
                  </Button>
                )}
                {state.config.modified ? (
                  <Button size="sm" variant="danger" onClick={() => dispatch({ type: "deleteModified" })}>
                    <Trash2 size={14} aria-hidden /> Remove modified
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => dispatch({ type: "createModified" })}>
                    <Plus size={14} aria-hidden /> Create modified scenario
                  </Button>
                )}
              </div>
            </div>
            <div key={state.ui.editing} className={cx("animate-fade", state.ui.editing === "modified" && "[&_section]:border-accent/25")}>
              <SpecEditor issues={v.issues} />
            </div>
          </>
        ) : (
          <Notice>
            Select a vehicle above to load its specifications. Not in the database? Use <strong className="text-ink">Custom vehicle</strong> — or describe it to the AI
            Build Assistant.
          </Notice>
        )}
      </div>
      <aside className="min-w-0">{stock ? <RunPanel /> : null}</aside>
    </div>
  );
}
