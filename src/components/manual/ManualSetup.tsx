"use client";

import { Play, RotateCcw } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import AdvancedSettings, { BASIC_KEYS } from "@/components/manual/AdvancedSettings";
import { ConditionsSummary, KeySpecs, ScenarioSetup } from "@/components/manual/BasicSetup";
import VehicleSelector from "@/components/manual/VehicleSelector";
import { Button, cx, Notice, Panel, Spinner } from "@/components/ui";
import { NUMERIC_FIELDS, SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveValues, sameValue } from "@/lib/domain/scenario";
import { DEFAULT_CONDITIONS, type Conditions, type NumericSpecKey, type SpecKey } from "@/lib/domain/types";
import { validateConfig, type Fix, type Issue } from "@/lib/domain/validation";
import { resolveInputs } from "@/lib/physics/resolve";
import { toDisplay, unitLabel } from "@/lib/units";
import { useApp } from "@/state/AppProvider";

export function useValidation() {
  const { state } = useApp();
  return useMemo(() => validateConfig(state.config), [state.config]);
}

const CONSTRAINT_LABEL: Record<string, string> = {
  claimedZeroTo60S: "Claimed 0–60 mph",
  claimedTopSpeedMs: "Claimed top speed",
  drivetrainTorqueLimitNm: "Drivetrain torque rating",
  tireSpeedRatingMs: "Tire speed rating",
};

const isAdvanced = (i: Issue) => i.scenario === "conditions" || (!!i.key && !BASIC_KEYS.includes(i.key as SpecKey));

function FixButton({ issue, fix }: { issue: Issue; fix: Fix }) {
  const { state, dispatch } = useApp();
  const def = NUMERIC_FIELDS[fix.key as NumericSpecKey];
  const display = def ? `${toDisplay(def.quantity, fix.value, state.ui.units).toFixed(0)} ${unitLabel(def.quantity, state.ui.units)}` : String(fix.value);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-auto min-h-7 px-2 py-1 text-left text-xs whitespace-normal text-accent"
      onClick={() => {
        const value = { value: fix.value, provenance: "user", source: "User-confirmed adjustment", note: fix.label } as never;
        if (issue.scenario === "modified") dispatch({ type: "setModifiedValue", key: fix.key, value });
        else dispatch({ type: "setStockValue", key: fix.key, value });
      }}
    >
      {fix.label} ({display})
    </Button>
  );
}

/** "Restore default" for an invalid explicit override, when a consistent default exists. */
function useRestore() {
  const { state, dispatch } = useApp();
  return (i: Issue): { label: string; run: () => void } | null => {
    if (!i.key) return null;
    if (i.scenario === "conditions") {
      const k = i.key as keyof Conditions;
      return { label: "Restore standard", run: () => dispatch({ type: "setConditions", patch: { [k]: DEFAULT_CONDITIONS[k] } }) };
    }
    const key = i.key as SpecKey;
    if (i.scenario === "modified") {
      if (!state.config.modified?.overrides[key]) return null;
      return { label: "Use stock value", run: () => dispatch({ type: "resetField", scenario: "modified", key }) };
    }
    const current = state.config.stock?.values[key];
    const estimate = state.config.stock?.identity.weightEstimate;
    if (key === "curbMassKg" && current?.value == null && estimate) {
      const shown = `${Math.round(toDisplay("mass", estimate.kg, state.ui.units)).toLocaleString("en-US")} ${unitLabel("mass", state.ui.units)}`;
      return {
        label: `Use estimated weight (≈ ${shown})`,
        run: () =>
          dispatch({ type: "setStockValue", key, value: { value: estimate.kg, provenance: "estimated", source: "AutoDyn estimate", note: estimate.basis } }),
      };
    }
    const original = state.baseline?.values[key];
    if (!original || !current || sameValue(original.value, current.value)) return null;
    if (original.value == null && (NUMERIC_FIELDS[key as NumericSpecKey]?.required ?? false)) return null;
    return { label: original.value == null ? "Use AutoDyn default" : "Restore source value", run: () => dispatch({ type: "resetField", scenario: "stock", key }) };
  };
}

export function IssueList({ issues, actions = true }: { issues: Issue[]; actions?: boolean }) {
  const { state, dispatch } = useApp();
  const restore = useRestore();
  if (!issues.length) return null;
  const focusField = (i: Issue) => {
    if (isAdvanced(i) && !state.ui.advancedOpen) dispatch({ type: "setAdvancedOpen", open: true });
    if (i.scenario !== "conditions" && i.scenario !== state.ui.editing && state.config.modified) dispatch({ type: "setEditing", scenario: i.scenario });
    const id =
      i.scenario === "conditions"
        ? ({ ambientTempC: "c-temp", elevationM: "c-elev", surface: "c-surface" } as Record<string, string>)[i.key ?? ""]
        : CONSTRAINT_LABEL[i.key ?? ""]
          ? `k-${i.key}`
          : `f-${i.key}`;
    window.setTimeout(() => document.getElementById(id ?? "")?.focus(), 60);
  };
  return (
    <ul className="space-y-2.5">
      {issues.map((i) => {
        const r = actions ? restore(i) : null;
        return (
          <li key={i.id} className="text-[12.5px] leading-5">
            <span className={i.severity === "error" ? "text-error" : "text-warning"}>
              {i.scenario === "conditions" ? "Conditions" : i.scenario === "modified" ? "Modified" : "Stock"}
              {i.key && i.scenario !== "conditions" ? ` · ${SPEC_LABEL[i.key as SpecKey] ?? CONSTRAINT_LABEL[i.key] ?? i.key}` : ""}
              {isAdvanced(i) ? " (Advanced)" : ""}:
            </span>{" "}
            <span className="text-muted">{i.message}</span>
            {actions && (
              <div className="mt-1 flex flex-wrap gap-1">
                {r && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-accent" onClick={r.run}>
                    <RotateCcw size={12} aria-hidden /> {r.label}
                  </Button>
                )}
                {i.fixes?.map((f) => <FixButton key={`${f.key}-${f.label}`} issue={i} fix={f} />)}
                {i.key && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => focusField(i)}>
                    Go to field
                  </Button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function useRunState() {
  const { state } = useApp();
  const v = useValidation();
  const errors = v.issues.filter((i) => i.severity === "error");
  const warnings = v.issues.filter((i) => i.severity === "warning");
  const acked = state.ui.ackRevision === state.revision;
  return { errors, warnings, acked, blocked: errors.length > 0 || (warnings.length > 0 && !acked) };
}

function RunPanel() {
  const { state, dispatch, running, runAnalysisNow, stale } = useApp();
  const { errors, warnings, acked, blocked } = useRunState();
  const result = state.result?.analysis;

  return (
    <div className="space-y-4 lg:sticky lg:top-[132px]">
      <Panel title="Run analysis" subtitle={state.config.modified ? "Stock vs. modified comparison" : "Stock scenario"}>
        <div className="space-y-3">
          {errors.length === 0 && warnings.length === 0 && <p className="text-[13px] text-success">Ready — all inputs are valid.</p>}
          {errors.length > 0 && (
            <div className="space-y-2" role="alert">
              <p className="text-[13px] font-medium text-error">
                {errors.length} invalid value{errors.length > 1 ? "s" : ""} must be fixed
              </p>
              <IssueList issues={errors} />
            </div>
          )}
          {warnings.length > 0 && (
            <div className="space-y-2">
              <p className="text-[13px] font-medium text-warning">
                {warnings.length} unusual value{warnings.length > 1 ? "s" : ""} — allowed after you confirm
              </p>
              <IssueList issues={warnings} />
              {errors.length === 0 && (
                <label className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[12.5px] leading-5 text-[#f1d39e]">
                  <input
                    type="checkbox"
                    checked={acked}
                    onChange={() => dispatch({ type: "ackWarnings" })}
                    disabled={acked}
                    className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                  />
                  I&apos;ve checked these values and want to simulate them as entered.
                </label>
              )}
            </div>
          )}
          <Button variant="primary" className="h-11 w-full text-[15px]" disabled={blocked || running} onClick={() => runAnalysisNow(true)}>
            {running ? <Spinner label="Running analysis" /> : <Play size={16} aria-hidden />}
            {running ? "Simulating…" : state.result && stale ? "Re-run analysis" : "Run analysis"}
          </Button>
          <p className="text-[11.5px] leading-4 text-faint">The deterministic physics engine runs in your browser — no AI is used for any number.</p>
        </div>
      </Panel>

      {result && (
        <Panel title="Latest result" subtitle={stale ? "Out of date — inputs changed" : "Matches current inputs"}>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <dt className="text-xs text-faint">Stock 0–60 mph</dt>
              <dd className="num text-lg text-stock">{result.stock.metrics.zeroTo60S?.toFixed(2) ?? "—"} s</dd>
            </div>
            {result.modified && (
              <div>
                <dt className="text-xs text-faint">Modified 0–60 mph</dt>
                <dd className="num text-lg text-modified">{result.modified.metrics.zeroTo60S?.toFixed(2) ?? "—"} s</dd>
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

const noop = () => () => {};

/**
 * Phones: the run action stays on screen without scrolling past every section. Rendered into
 * <body> because animated (transformed) ancestors would otherwise become the containing block
 * for `position: fixed` and the bar would scroll away with the page.
 */
function MobileRunBar() {
  const { state, running, runAnalysisNow, stale } = useApp();
  const { errors, warnings, acked, blocked } = useRunState();
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  if (!mounted) return null;
  return createPortal(
    <div className="no-print fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-[2px] lg:hidden" data-testid="mobile-run-bar">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-3">
        <span className={cx("min-w-0 text-xs leading-4", errors.length ? "text-error" : warnings.length && !acked ? "text-warning" : "text-muted")}>
          {errors.length
            ? `${errors.length} invalid value${errors.length > 1 ? "s" : ""} to fix`
            : warnings.length && !acked
              ? `Confirm ${warnings.length} unusual value${warnings.length > 1 ? "s" : ""}`
              : state.config.modified
                ? "Stock vs. modified"
                : "Stock only"}
        </span>
        <Button variant="primary" className="h-11 shrink-0 px-5" disabled={blocked || running} onClick={() => runAnalysisNow(true)} aria-label="Run analysis (mobile)">
          {running ? <Spinner label="Running analysis" /> : <Play size={15} aria-hidden />}
          {state.result && stale ? "Re-run" : "Run analysis"}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

export default function ManualSetup() {
  const { state, dispatch } = useApp();
  const v = useValidation();
  const stock = state.config.stock;
  const [confirmReset, setConfirmReset] = useState(false);

  const assumptions = useMemo(() => {
    if (!stock) return 0;
    const r = resolveInputs(effectiveValues(state.config, "stock")!, state.config.conditions, stock.identity);
    return r.ok ? r.estimates.filter((e) => e.key !== "launchRpm").length : 0;
  }, [state.config, stock]);

  return (
    <div className={cx("grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]", stock && "pb-24 lg:pb-0")}>
      {stock && <MobileRunBar />}
      <div className="min-w-0 space-y-4">
        {state.restored && stock && (
          <Notice
            action={
              <div className="flex gap-2">
                <Button size="sm" onClick={() => dispatch({ type: "startFresh" })}>
                  Start fresh
                </Button>
                <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "dismissRestored" })}>
                  Keep
                </Button>
              </div>
            }
          >
            Restored your previous session from this browser, including any values you edited.
            {state.restoredFixes.length > 0 && (
              <span className="mt-1 block text-warning">
                {state.restoredFixes.length} saved value{state.restoredFixes.length > 1 ? "s were" : " was"} physically invalid and reset to the source data:{" "}
                {state.restoredFixes.join(", ")}.
              </span>
            )}
          </Notice>
        )}

        <Panel
          title="Vehicle"
          subtitle="Choose a vehicle from the database, decode a VIN, or enter one manually."
        >
          <VehicleSelector />
        </Panel>

        {stock ? (
          <>
            <KeySpecs issues={v.issues} />
            <ScenarioSetup />
            <ConditionsSummary />
            <AdvancedSettings issues={v.issues} assumptions={assumptions} />
            <div className="flex flex-wrap items-center gap-2">
              {confirmReset ? (
                <Notice
                  tone="warning"
                  action={
                    <div className="flex gap-2">
                      <Button size="sm" variant="danger" onClick={() => (dispatch({ type: "resetAll" }), setConfirmReset(false))}>
                        Reset
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                        Cancel
                      </Button>
                    </div>
                  }
                >
                  Reset to the vehicle&apos;s source data, remove the modified scenario and restore standard conditions?
                </Notice>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>
                  <RotateCcw size={14} aria-hidden /> Reset configuration
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-line-strong px-5 py-8 text-center">
            <p className="text-[14px] font-medium text-ink">Start by choosing a vehicle</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-5 text-muted">
              Most 2015–2020 models load verified power and weight automatically. Anything else can be identified by NHTSA or entered manually — or just describe it to the AI Build
              Assistant.
            </p>
          </div>
        )}
      </div>
      <aside className="min-w-0">{stock ? <RunPanel /> : null}</aside>
    </div>
  );
}
