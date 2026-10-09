"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { CommitInput, formatDisplay, inputClass, NumericField, Row, SelectField, useFieldBinding } from "@/components/manual/controls";
import { BASIC_KEYS } from "@/components/manual/AdvancedSettings";
import WeightField from "@/components/manual/WeightField";
import { Button, cx, Notice, Panel, ProvenanceTag, Segmented } from "@/components/ui";
import { DRIVETRAIN_OPTIONS, NUMERIC_FIELDS, SURFACE_OPTIONS, TRANSMISSION_OPTIONS } from "@/lib/domain/fields";
import { effectiveValues, modifiedDiff } from "@/lib/domain/scenario";
import { DEFAULT_CONDITIONS, type NumericSpecKey } from "@/lib/domain/types";
import type { Issue } from "@/lib/domain/validation";
import { fromDisplay, toDisplay, unitLabel } from "@/lib/units";
import { useApp } from "@/state/AppProvider";

/** Essentials only: power, weight, optional torque, drivetrain when the source lacks it. */
export function KeySpecs({ issues }: { issues: Issue[] }) {
  const { state } = useApp();
  const b = useFieldBinding("stock");
  const [showTorque, setShowTorque] = useState(false);
  const issueFor = (k: string) => issues.find((i) => i.key === k && i.scenario === "stock");
  const v = b.values;
  const torqueShown = showTorque || v.peakTorqueNm.value != null || !!issueFor("peakTorqueNm");
  const drivetrainKnown = v.drivetrain.value != null && v.drivetrain.provenance === "verified";
  const identity = state.config.stock!.identity;
  const facts = [
    identity.engineDescription,
    drivetrainKnown ? DRIVETRAIN_OPTIONS.find((o) => o.value === v.drivetrain.value)?.label : null,
    v.transmission.value ? TRANSMISSION_OPTIONS.find((o) => o.value === v.transmission.value)?.label.replace(/ \(.*\)/, "") : null,
    identity.bodyStyle,
  ].filter(Boolean);

  return (
    <Panel
      title="Key specifications"
      subtitle={
        identity.source === "dataset"
          ? `Verified values from ${identity.sourceDetail}. Edit only if your car differs.`
          : "Enter what you know. Power and vehicle weight are all that's required."
      }
    >
      <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
        <NumericField b={b} k="peakPowerKw" label="Power" issue={issueFor("peakPowerKw")} showHelp={v.peakPowerKw.value == null} />
        <WeightField b={b} issue={issueFor("curbMassKg")} />
        {torqueShown ? (
          <NumericField b={b} k="peakTorqueNm" label="Torque (optional)" issue={issueFor("peakTorqueNm")} showHelp={v.peakTorqueNm.value == null} />
        ) : (
          <div className="flex items-end">
            <Button size="sm" variant="ghost" onClick={() => setShowTorque(true)}>
              <Plus size={14} aria-hidden /> Add torque (optional)
            </Button>
          </div>
        )}
        {!drivetrainKnown && (
          <SelectField b={b} k="drivetrain" label="Driven wheels" options={DRIVETRAIN_OPTIONS} issue={issueFor("drivetrain")} help="Which wheels are powered. Affects launch grip." />
        )}
      </div>
      {facts.length > 0 && (
        <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-3 text-xs text-muted">
          {drivetrainKnown && <ProvenanceTag provenance="verified" title={v.drivetrain.source} />}
          {facts.join(" · ")}
        </p>
      )}
    </Panel>
  );
}

/** Signed change relative to stock, committed as an absolute modified value (user-provided assumption). */
function DeltaField({ k, label, chips }: { k: NumericSpecKey; label: string; chips: { label: string; delta: (stockDisplay: number) => number }[] }) {
  const { state, dispatch } = useApp();
  const units = state.ui.units;
  const def = NUMERIC_FIELDS[k];
  const stock = state.config.stock!.values[k].value;
  const mod = effectiveValues(state.config, "modified")![k].value;
  const unit = unitLabel(def.quantity, units);
  if (stock == null) {
    return (
      <div className="min-w-0 text-[12.5px] leading-5 text-muted">
        <div className="mb-1 text-[13px] font-medium">{label}</div>
        Set the stock {k === "curbMassKg" ? "vehicle weight" : NUMERIC_FIELDS[k].label.toLowerCase()} first.
      </div>
    );
  }
  const stockD = toDisplay(def.quantity, stock, units);
  const modD = mod == null ? stockD : toDisplay(def.quantity, mod, units);
  const delta = Math.round((modD - stockD) * 10) / 10;
  const commit = (d: number | null) => {
    if (d == null || Math.abs(d) < 1e-9) return dispatch({ type: "resetField", scenario: "modified", key: k });
    const value = fromDisplay(def.quantity, stockD + d, units);
    dispatch({
      type: "setModifiedValue",
      key: k,
      // Stored relative to stock so later corrections to the stock value carry through.
      value: { value, delta: value - stock, provenance: "user", source: "User-provided assumption", note: `${d > 0 ? "+" : ""}${d} ${unit} vs stock` },
    });
  };
  return (
    <div className="min-w-0">
      <Row label={label} htmlFor={`d-${k}`} unit={unit} hint={`Modified: ${formatDisplay(def, mod ?? stock, units)} ${unit} · Stock: ${formatDisplay(def, stock, units)} ${unit}`}>
        <CommitInput
          id={`d-${k}`}
          value={delta === 0 ? "" : `${delta > 0 ? "+" : ""}${delta}`}
          placeholder="0 (no change)"
          className="pr-14"
          onCommit={(t) => {
            const s = t.trim().replace(/,/g, "");
            if (!s) return commit(null);
            const n = Number(s);
            if (Number.isFinite(n)) commit(n);
          }}
        />
      </Row>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={() => commit(Math.round(c.delta(stockD)))}
            className="h-8 rounded-sm border border-line px-2.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-ink sm:h-7 sm:px-2"
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const TIRE_PRESETS = [
  { id: "stock", label: "Same as stock", mu: null },
  { id: "summer", label: "Performance summer tires (assumed grip 1.10)", mu: 1.1 },
  { id: "track", label: "Track / R-compound tires (assumed grip 1.25)", mu: 1.25 },
] as const;

export function ScenarioSetup() {
  const { state, dispatch } = useApp();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const units = state.ui.units;
  const modified = !!state.config.modified;
  const changes = modifiedDiff(state.config);
  const advancedChanges = changes.filter((k) => !BASIC_KEYS.includes(k) && k !== "tireMu");
  const stock = state.config.stock!.values;
  const modMu = state.config.modified?.overrides.tireMu?.value ?? null;
  const preset = modMu == null ? "stock" : TIRE_PRESETS.find((p) => p.mu === modMu)?.id ?? "custom";
  const imperial = units === "imperial";

  return (
    <Panel
      title="What do you want to analyze?"
      actions={
        <Segmented
          label="Analysis type"
          value={modified ? "compare" : "stock"}
          onChange={(v) => {
            if (v === "compare") return dispatch({ type: "createModified" });
            if (changes.length) setConfirmRemove(true);
            else dispatch({ type: "deleteModified" });
          }}
          options={[
            { value: "stock", label: "Stock only" },
            { value: "compare", label: "Stock vs. modified" },
          ]}
        />
      }
    >
      {confirmRemove && (
        <div className="mb-4">
          <Notice
            tone="warning"
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="danger" onClick={() => (dispatch({ type: "deleteModified" }), setConfirmRemove(false))}>
                  Remove
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </div>
            }
          >
            Remove the modified scenario and its {changes.length} change{changes.length > 1 ? "s" : ""}?
          </Notice>
        </div>
      )}
      {!modified ? (
        <p className="text-[13px] leading-5 text-muted">
          AutoDyn will simulate the vehicle as specified. Choose <span className="text-ink">Stock vs. modified</span> to compare a build — for example more power or less weight.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] leading-5 text-muted">
            Describe your modification as changes from stock. These are <span className="text-ink">your assumptions</span> — AutoDyn doesn&apos;t guess what parts deliver.
          </p>
          <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
            <DeltaField
              k="peakPowerKw"
              label="Power change"
              chips={[
                { label: "+10%", delta: (s) => s * 0.1 },
                { label: "+20%", delta: (s) => s * 0.2 },
                { label: imperial ? "+50 hp" : "+40 kW", delta: () => (imperial ? 50 : 40) },
              ]}
            />
            <DeltaField
              k="curbMassKg"
              label="Vehicle weight change"
              chips={[
                { label: imperial ? "−100 lb" : "−50 kg", delta: () => (imperial ? -100 : -50) },
                { label: imperial ? "−250 lb" : "−100 kg", delta: () => (imperial ? -250 : -100) },
              ]}
            />
            {stock.peakTorqueNm.value != null && (
              <DeltaField k="peakTorqueNm" label="Torque change" chips={[{ label: "+10%", delta: (s) => s * 0.1 }, { label: "+20%", delta: (s) => s * 0.2 }]} />
            )}
            <Row label="Tires" htmlFor="d-tires" hint="Grip values are labeled model assumptions, not tire-maker data.">
              <select
                id="d-tires"
                value={preset}
                onChange={(e) => {
                  const p = TIRE_PRESETS.find((x) => x.id === e.target.value);
                  if (!p || p.mu == null) return dispatch({ type: "resetField", scenario: "modified", key: "tireMu" });
                  dispatch({ type: "setModifiedValue", key: "tireMu", value: { value: p.mu, provenance: "user", source: "User-provided assumption", note: p.label } });
                }}
                className={cx(inputClass, "border-line font-sans")}
              >
                {TIRE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                {preset === "custom" && <option value="custom">Custom grip {modMu} (Advanced Settings)</option>}
              </select>
            </Row>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
            <span>
              {changes.length ? `${changes.length} change${changes.length > 1 ? "s" : ""} from stock` : "No changes yet — modified matches stock."}
              {advancedChanges.length > 0 && ` (${advancedChanges.length} in Advanced Settings)`}
            </span>
            {changes.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => changes.forEach((k) => dispatch({ type: "resetField", scenario: "modified", key: k }))}>
                Clear changes
              </Button>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function ConditionsSummary() {
  const { state, dispatch } = useApp();
  const c = state.config.conditions;
  const standard = c.ambientTempC === DEFAULT_CONDITIONS.ambientTempC && c.elevationM === DEFAULT_CONDITIONS.elevationM && c.surface === DEFAULT_CONDITIONS.surface;
  const units = state.ui.units;
  const text = `${SURFACE_OPTIONS.find((s) => s.value === c.surface)?.label.replace(" (standard)", "")} · ${Math.round(toDisplay("temperature", c.ambientTempC, units))} ${unitLabel("temperature", units)} · ${
    c.elevationM === 0 ? "sea level" : `${Math.round(toDisplay("elevation", c.elevationM, units)).toLocaleString()} ${unitLabel("elevation", units)} elevation`
  }`;
  return (
    <div className={cx("flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3 text-[13px] sm:px-5", standard ? "border-line bg-surface" : "border-caution/40 bg-caution/5")}>
      <span className="min-w-0">
        <span className="font-medium text-ink">{standard ? "Standard conditions" : "Non-standard conditions"}</span>
        <span className="ml-2 text-muted">{text}</span>
      </span>
      {standard ? (
        <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "setAdvancedOpen", open: true })}>
          Change
        </Button>
      ) : (
        <Button size="sm" onClick={() => dispatch({ type: "setConditions", patch: { ...DEFAULT_CONDITIONS, rollout: c.rollout } })}>
          Reset to standard
        </Button>
      )}
    </div>
  );
}
