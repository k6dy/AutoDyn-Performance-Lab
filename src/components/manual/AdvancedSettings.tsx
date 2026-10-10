"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { CommitInput, NumericField, Row, SelectField, useFieldBinding, inputClass } from "@/components/manual/controls";
import ConstraintFields from "@/components/manual/ConstraintFields";
import { cx, Segmented } from "@/components/ui";
import { ASPIRATION_OPTIONS, POWERTRAIN_OPTIONS, SURFACE_OPTIONS, TRANSMISSION_OPTIONS } from "@/lib/domain/fields";
import { sameValue } from "@/lib/domain/scenario";
import { DEFAULT_CONDITIONS, type Conditions, type SpecKey } from "@/lib/domain/types";
import type { Issue } from "@/lib/domain/validation";
import { fromDisplay, tireSizeToRadiusM, toDisplay, unitLabel } from "@/lib/units";
import { useApp } from "@/state/AppProvider";

/** Keys shown in Basic Setup; everything else lives here. */
export const BASIC_KEYS: SpecKey[] = ["peakPowerKw", "curbMassKg", "peakTorqueNm", "drivetrain"];

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-4 first:border-t-0 sm:px-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-[13.5px] font-semibold tracking-tight">{title}</h4>
        {note && <p className="text-xs text-faint">{note}</p>}
      </div>
      <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

/** Read-only: the mass the simulation actually accelerates. */
function TestMass({ b }: { b: ReturnType<typeof useFieldBinding> }) {
  const curb = b.values.curbMassKg.value;
  const payload = b.values.payloadKg.value ?? (b.estimates.get("payloadKg")?.value as number | undefined) ?? 80;
  const u = unitLabel("mass", b.units);
  const f = (kg: number) => Math.round(toDisplay("mass", kg, b.units)).toLocaleString("en-US");
  return (
    <div className="min-w-0 text-[13px]">
      <div className="mb-1 text-[13px] font-medium text-muted">Simulated test mass</div>
      <div className="num flex h-10 items-center rounded-md border border-dashed border-line px-3 text-ink sm:h-9">
        {curb != null ? `${f(curb + payload)} ${u}` : "Needs vehicle weight"}
      </div>
      <div className="mt-1 text-[12px] leading-4 text-faint">Vehicle weight + driver & cargo.</div>
    </div>
  );
}

function ScenarioFields({ issues }: { issues: Issue[] }) {
  const { state } = useApp();
  const b = useFieldBinding(state.ui.editing);
  const issueFor = (k: string) => issues.find((i) => i.key === k && i.scenario === b.scenario);
  const isEv = b.values.powertrain.value === "ev";
  const cvt = b.values.transmission.value === "cvt";
  const gearText = b.values.gearRatios.value ? b.values.gearRatios.value.map((r) => Number(r.toFixed(3))).join(" / ") : "";
  const gearEst = b.estimates.get("gearRatios");

  return (
    <>
      <Group title="Powertrain details">
        <SelectField b={b} k="powertrain" label="Powertrain type" options={POWERTRAIN_OPTIONS} issue={issueFor("powertrain")} />
        {!isEv && <SelectField b={b} k="aspiration" label="Induction" options={ASPIRATION_OPTIONS.filter((o) => o.value !== "electric")} issue={issueFor("aspiration")} help="Turbo/supercharged engines lose less power at altitude." />}
        {!isEv && <SelectField b={b} k="transmission" label="Transmission" options={TRANSMISSION_OPTIONS.filter((o) => o.value !== "direct")} issue={issueFor("transmission")} />}
        {!isEv && <NumericField b={b} k="peakPowerRpm" issue={issueFor("peakPowerRpm")} />}
        {!isEv && <NumericField b={b} k="peakTorqueRpm" issue={issueFor("peakTorqueRpm")} />}
        <NumericField b={b} k="redlineRpm" issue={issueFor("redlineRpm")} />
      </Group>

      <Group title="Gearing">
        {!isEv && !cvt && <NumericField b={b} k="gearCount" issue={issueFor("gearCount")} />}
        {!isEv && !cvt && (
          <Row
            label="Gear ratios (first → top)"
            htmlFor="f-gearRatios"
            provenance={b.provenanceOf("gearRatios")}
            hint={b.values.gearRatios.value == null && gearEst ? `AutoDyn default: ${(gearEst.value as number[]).join(" / ")} — ${gearEst.reason}` : b.values.gearRatios.note}
            help="Separate ratios with spaces, commas or slashes."
            issue={issueFor("gearRatios")}
            compare={b.scenario === "modified" && !sameValue(b.values.gearRatios.value, b.stockValues.gearRatios.value) ? `Stock: ${b.stockValues.gearRatios.value?.join(" / ") ?? "default"}` : undefined}
            {...b.resetInfo("gearRatios")}
          >
            <CommitInput
              id="f-gearRatios"
              inputMode="text"
              value={gearText}
              placeholder="e.g. 4.38 / 2.86 / 1.92 / 1.37 / 1.00"
              invalid={issueFor("gearRatios")?.severity === "error"}
              onCommit={(t) => {
                if (!t.trim()) return b.set("gearRatios", null);
                const parts = t.split(/[\s/,;]+/).filter(Boolean).map(Number);
                if (parts.every((n) => Number.isFinite(n))) b.set("gearRatios", parts);
              }}
            />
          </Row>
        )}
        <NumericField b={b} k="finalDrive" issue={issueFor("finalDrive")} />
        {!isEv && !cvt && <NumericField b={b} k="shiftTimeS" issue={issueFor("shiftTimeS")} />}
      </Group>

      <Group title="Mass" note="Vehicle weight (curb) is set in Key specifications.">
        <NumericField b={b} k="payloadKg" issue={issueFor("payloadKg")} />
        <TestMass b={b} />
      </Group>

      <Group title="Aerodynamics & losses">
        <NumericField b={b} k="dragCoefficient" issue={issueFor("dragCoefficient")} />
        <NumericField b={b} k="frontalAreaM2" issue={issueFor("frontalAreaM2")} />
        <NumericField b={b} k="drivetrainEfficiency" issue={issueFor("drivetrainEfficiency")} />
      </Group>

      <Group title="Claims & component limits (optional)" note="Used only by the feasibility assessment, never by the physics.">
        <ConstraintFields issues={issues} />
      </Group>

      <Group title="Tires & traction">
        <NumericField b={b} k="tireMu" issue={issueFor("tireMu")} />
        <NumericField b={b} k="tireRadiusM" issue={issueFor("tireRadiusM")} />
        <Row label="Tire size helper" htmlFor="f-tireSize" hint="Enter a size like 225/45R17 to set the rolling radius.">
          <CommitInput
            id="f-tireSize"
            inputMode="text"
            value=""
            placeholder="225/45R17"
            onCommit={(t) => {
              const r = tireSizeToRadiusM(t);
              if (r) b.set("tireRadiusM", Number(r.toFixed(4)), `From tire size ${t.trim().toUpperCase()}`);
            }}
          />
        </Row>
        <NumericField b={b} k="rollingResistance" issue={issueFor("rollingResistance")} />
        <NumericField b={b} k="frontWeightFraction" issue={issueFor("frontWeightFraction")} />
        <NumericField b={b} k="cgHeightRatio" issue={issueFor("cgHeightRatio")} />
      </Group>
    </>
  );
}

export function ConditionsFields({ issues }: { issues: Issue[] }) {
  const { state, dispatch } = useApp();
  const c = state.config.conditions;
  const units = state.ui.units;
  const condIssue = (k: string) => issues.find((i) => i.scenario === "conditions" && i.key === k);
  const reset = (k: keyof Conditions) =>
    c[k] !== DEFAULT_CONDITIONS[k] ? { onReset: () => dispatch({ type: "setConditions", patch: { [k]: DEFAULT_CONDITIONS[k] } }), resetLabel: "Restore standard" } : {};
  return (
    <Group title="Conditions" note="Shared by both scenarios so comparisons stay fair.">
      <Row label="Air temperature" htmlFor="c-temp" provenance="user" unit={unitLabel("temperature", units)} issue={condIssue("ambientTempC")} help="Standard: 25 °C (77 °F). Rated power is assumed at standard conditions." {...reset("ambientTempC")}>
        <CommitInput
          id="c-temp"
          value={String(Math.round(toDisplay("temperature", c.ambientTempC, units)))}
          className="pr-10"
          onCommit={(t) => {
            const n = Number(t);
            if (t.trim() && Number.isFinite(n)) dispatch({ type: "setConditions", patch: { ambientTempC: fromDisplay("temperature", n, units) } });
          }}
        />
      </Row>
      <Row label="Elevation" htmlFor="c-elev" provenance="user" unit={unitLabel("elevation", units)} issue={condIssue("elevationM")} help="Standard: sea level. Thinner air reduces drag and non-turbo engine power." {...reset("elevationM")}>
        <CommitInput
          id="c-elev"
          value={String(Math.round(toDisplay("elevation", c.elevationM, units)))}
          className="pr-10"
          onCommit={(t) => {
            const n = Number(t);
            if (t.trim() && Number.isFinite(n)) dispatch({ type: "setConditions", patch: { elevationM: fromDisplay("elevation", n, units) } });
          }}
        />
      </Row>
      <Row label="Road surface" htmlFor="c-surface" provenance="user" help={`Grip multiplier × ${SURFACE_OPTIONS.find((s) => s.value === c.surface)?.factor}`} {...reset("surface")}>
        <select id="c-surface" value={c.surface} onChange={(e) => dispatch({ type: "setConditions", patch: { surface: e.target.value as Conditions["surface"] } })} className={cx(inputClass, "border-line font-sans")}>
          {SURFACE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </Row>
      <div className="flex items-start gap-2.5 sm:pt-6">
        <input id="c-rollout" type="checkbox" checked={c.rollout} onChange={(e) => dispatch({ type: "setConditions", patch: { rollout: e.target.checked } })} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        <label htmlFor="c-rollout" className="text-xs leading-5 text-muted">
          Subtract 1-ft rollout from 0–60 (the US magazine convention)
        </label>
      </div>
    </Group>
  );
}

export default function AdvancedSettings({ issues, assumptions }: { issues: Issue[]; assumptions: number }) {
  const { state, dispatch } = useApp();
  const open = state.ui.advancedOpen;
  const advancedErrors = issues.filter((i) => i.severity === "error" && (i.scenario === "conditions" || (i.key && !BASIC_KEYS.includes(i.key as SpecKey)))).length;

  return (
    <section className={cx("rounded-lg border bg-surface", advancedErrors ? "border-error/50" : "border-line")} id="advanced-settings">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="advanced-settings-body"
        onClick={() => dispatch({ type: "setAdvancedOpen", open: !open })}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left sm:px-5"
      >
        <span className="min-w-0">
          <span className="block text-[14px] font-semibold tracking-tight text-ink">Advanced Settings</span>
          <span className="mt-0.5 block text-xs leading-4 text-muted">
            {advancedErrors
              ? `${advancedErrors} invalid value${advancedErrors > 1 ? "s" : ""} here — open to fix or restore defaults.`
              : `Optional. ${assumptions} detail${assumptions === 1 ? "" : "s"} use documented AutoDyn defaults (aerodynamics, gearing, tires, conditions). Override any of them here.`}
          </span>
        </span>
        <ChevronDown size={18} aria-hidden className={cx("shrink-0 text-muted transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div id="advanced-settings-body" className="animate-enter border-t border-line">
          <div className="flex flex-wrap items-center gap-3 px-4 pt-4 sm:px-5">
            <span className="text-xs font-medium text-muted">Settings for</span>
            <Segmented
              label="Scenario for advanced settings"
              size="sm"
              value={state.ui.editing}
              onChange={(s) => dispatch({ type: "setEditing", scenario: s })}
              options={[
                { value: "stock", label: "Stock" },
                { value: "modified", label: "Modified", disabled: !state.config.modified, title: state.config.modified ? undefined : "Turn on the modified comparison first" },
              ]}
            />
          </div>
          {state.ui.editing === "modified" && <p className="px-4 pt-2 text-xs text-modified sm:px-5">Editing the Modified scenario — Stock values are not changed.</p>}
          <div key={state.ui.editing} className="animate-fade">
            <ScenarioFields issues={issues} />
          </div>
          <div className="border-t border-line">
            <ConditionsFields issues={issues} />
          </div>
        </div>
      )}
    </section>
  );
}
