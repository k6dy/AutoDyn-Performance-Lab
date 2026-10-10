"use client";

import { Info } from "lucide-react";
import { useId, useState } from "react";
import { CommitInput, formatDisplay, inputClass, parseDisplay, type Binding } from "@/components/manual/controls";
import { Button, cx, ProvenanceTag } from "@/components/ui";
import { NUMERIC_FIELDS } from "@/lib/domain/fields";
import type { Provenance, WeightEstimate } from "@/lib/domain/types";
import type { Issue } from "@/lib/domain/validation";
import { unitLabel } from "@/lib/units";
import { classifyVehicle, estimateForClass, VEHICLE_CLASSES, type VehicleClassId } from "@/lib/vehicles/weight";
import { useApp } from "@/state/AppProvider";

const SOURCE_LABEL: Record<Provenance, string> = { verified: "Verified", estimated: "Estimated", user: "Manually entered", unavailable: "Needed" };

export function InfoTip({ text, label }: { text: string; label: string }) {
  const id = useId();
  return (
    <span className="group inline-flex">
      <button type="button" aria-label={label} aria-describedby={id} className="grid h-5 w-5 place-items-center rounded-full text-faint hover:text-ink focus-visible:text-ink">
        <Info size={13} aria-hidden />
      </button>
      <span
        role="tooltip"
        id={id}
        className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 hidden w-64 max-w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-xs leading-4 font-normal text-muted shadow-lg group-focus-within:block group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}

/** The estimate the vehicle's source provides, else one from the vehicle type the user picks. */
export function useWeightEstimate(): { estimate: WeightEstimate | null; classId: VehicleClassId | ""; setClassId: (c: VehicleClassId | "") => void; fromSource: boolean } {
  const { state } = useApp();
  const identity = state.config.stock!.identity;
  const [picked, setPicked] = useState<{ key: string; id: VehicleClassId | "" } | null>(null);
  // Keyed to the vehicle so a type chosen for one vehicle never carries over to another.
  const vehicleKey = `${identity.source}|${identity.datasetTrimId ?? ""}|${identity.year}|${identity.make}|${identity.model}`;
  const guess = identity.source === "custom" ? "" : (classifyVehicle(identity.bodyStyle) ?? "");
  const classId = picked && picked.key === vehicleKey ? picked.id : guess;
  const setClassId = (id: VehicleClassId | "") => setPicked({ key: vehicleKey, id });
  if (identity.weightEstimate) return { estimate: identity.weightEstimate, classId, setClassId, fromSource: true };
  return { estimate: classId ? estimateForClass(classId) : null, classId, setClassId, fromSource: false };
}

export default function WeightField({ b, issue }: { b: Binding; issue?: Issue }) {
  const { state, dispatch } = useApp();
  const units = state.ui.units;
  const def = NUMERIC_FIELDS.curbMassKg;
  const unit = unitLabel("mass", units);
  const v = b.values.curbMassKg;
  const baseline = state.baseline?.values.curbMassKg;
  const { estimate, classId, setClassId, fromSource } = useWeightEstimate();
  const provenance: Provenance = v.value == null ? "unavailable" : v.provenance;
  const fmt = (kg: number) => `${formatDisplay(def, kg, units)} ${unit}`;
  const focusInput = () => document.getElementById("f-curbMassKg")?.focus();
  const useEstimate = () => {
    if (!estimate) return;
    dispatch({ type: "setStockValue", key: "curbMassKg", value: { value: estimate.kg, provenance: "estimated", source: "AutoDyn estimate", note: estimate.basis } });
  };
  const canRestore = baseline?.value != null && (baseline.value !== v.value || baseline.provenance !== v.provenance);
  const linkClass = "text-muted underline decoration-dotted underline-offset-2 hover:text-ink";

  return (
    <div className="min-w-0" data-field="f-curbMassKg">
      <div className="relative mb-1 flex min-h-[18px] items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <label htmlFor="f-curbMassKg" className="text-[13px] font-medium text-muted">
            Vehicle weight
          </label>
          <InfoTip
            label="About vehicle weight"
            text="Curb weight: the vehicle with fluids, without occupants or cargo. AutoDyn adds the driver separately (80 kg / 176 lb by default — change it in Advanced Settings → Mass)."
          />
        </span>
        <ProvenanceTag provenance={provenance} label={SOURCE_LABEL[provenance]} title={v.source} />
      </div>
      <div className="relative">
        <CommitInput
          id="f-curbMassKg"
          ariaDescribedBy="f-curbMassKg-hint"
          value={formatDisplay(def, v.value, units)}
          placeholder={estimate ? `Needed (estimate ≈ ${fmt(estimate.kg)})` : "Needed"}
          invalid={issue?.severity === "error" && v.value != null}
          className="pr-12"
          onCommit={(text) => {
            const si = parseDisplay(def, text, units);
            if (si === undefined) return;
            dispatch({
              type: "setStockValue",
              key: "curbMassKg",
              value: si == null ? { value: null, provenance: "unavailable" } : { value: si, provenance: "user", source: "Entered manually" },
            });
          }}
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-faint">{unit}</span>
      </div>
      <div id="f-curbMassKg-hint" className="mt-1 space-y-1.5 text-[12px] leading-4">
        {issue && v.value != null && <div className={issue.severity === "error" ? "text-error" : "text-warning"}>{issue.message}</div>}
        {v.value == null && (
          <div className="rounded-md border border-line bg-bg/60 px-3 py-2.5" data-testid="weight-estimate">
            <p className="text-muted">
              No published curb weight for this vehicle.{" "}
              {estimate ? (
                <>
                  AutoDyn can use an <span className="text-estimated">estimate of ≈ {fmt(estimate.kg)}</span> (typical range {fmt(estimate.lowKg)}–{fmt(estimate.highKg)}).
                </>
              ) : (
                "Pick a vehicle type for an estimate, or enter the weight."
              )}
            </p>
            {estimate && <p className="mt-1 text-faint">{estimate.basis}</p>}
            {!fromSource && (
              <select
                aria-label="Vehicle type for weight estimate"
                value={classId}
                onChange={(e) => setClassId(e.target.value as VehicleClassId | "")}
                className={cx(inputClass, "mt-2 border-line font-sans")}
              >
                <option value="">Vehicle type…</option>
                {VEHICLE_CLASSES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {estimate && (
                <Button size="sm" variant="primary" onClick={useEstimate}>
                  Use estimated weight
                </Button>
              )}
              <Button size="sm" onClick={focusInput}>
                Enter manually
              </Button>
            </div>
          </div>
        )}
        {v.value != null && v.provenance === "estimated" && (
          <div className="text-faint">
            Estimate — {v.note ?? "AutoDyn estimate"}{" "}
            <button type="button" onClick={focusInput} className={linkClass}>
              Enter actual weight
            </button>
          </div>
        )}
        {v.value != null && v.provenance === "user" && (
          <div className="text-faint">
            You entered this value.{" "}
            {canRestore ? (
              <button type="button" onClick={() => dispatch({ type: "resetField", scenario: "stock", key: "curbMassKg" })} className={linkClass}>
                Restore published weight ({fmt(baseline!.value!)})
              </button>
            ) : estimate ? (
              <button type="button" onClick={useEstimate} className={linkClass}>
                Use estimate instead (≈ {fmt(estimate.kg)})
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
