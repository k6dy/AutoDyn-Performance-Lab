// Keeps a scenario's power and torque mathematically consistent when a request specifies only some
// of them ("add 60 hp"). Pure and deterministic — shared by the AI proposal pipeline and Manual
// Setup, so both build identical scenarios. Gemini never computes these values.
//
// Documented assumption — "proportional curve": when only peak power (or only peak torque) is
// requested, the whole full-load torque curve is scaled by one factor k with every rpm position
// unchanged. AutoDyn's curve model (physics/curve.ts) is homogeneous in peak power and peak torque,
// so k·P and k·T give exactly k × the original torque at every rpm: the shape, torque-peak speed and
// power-peak speed are preserved and power = torque × ω holds everywhere. Peak torque and the torque
// at the power-peak speed both scale by k; they are not assumed to coincide. This is a hypothetical
// modeling choice, not a prediction of what a real modification (tune, turbo, motor) produces.
//
// Values the user stated or fixed are never changed here. When they can't be reconciled, the result
// is a conflict with explicit options the user may approve (scale the other value, or move the
// power-peak speed within the current redline).

import type { SpecKey, SpecValues, VehicleIdentity } from "@/lib/domain/types";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import type { CurveParams } from "@/lib/physics/curve";
import { resolveInputs } from "@/lib/physics/resolve";
import { radSToRpm, rpmToRadS } from "@/lib/units";

/** Source label for values AutoDyn derived under a documented modeling assumption. */
export const MODEL_SOURCE = "AutoDyn modeling assumption";

export const CURVE_KEYS = ["peakPowerKw", "peakTorqueNm", "peakPowerRpm", "redlineRpm"] as const;
export type CurveKey = (typeof CURVE_KEYS)[number];
export const isCurveKey = (k: string): k is CurveKey => (CURVE_KEYS as readonly string[]).includes(k);

export type CurveChoice = "scale" | "rpm";

/** A value AutoDyn derived (SI); applied with "estimated" provenance. */
export type DerivedValue = { key: CurveKey; from: number | null; to: number; reason: string };

export type CurveOption = { id: CurveChoice; label: string; derived: DerivedValue[] };

export type CurveModel = {
  /**
   * unchanged: power and torque are not part of the request · consistent: the stated values already
   * form a valid curve · derived: dependent values were inferred (see `derived`) · conflict: stated
   * values can't be reconciled; `options` lists approvable resolutions.
   */
  status: "unchanged" | "consistent" | "derived" | "conflict";
  derived: DerivedValue[];
  /** One sentence describing the modeling assumption used, for review panels and reports. */
  assumption: string | null;
  conflict: string | null;
  options: CurveOption[];
  /** The option the user approved for a conflict, when one was applied. */
  choice: CurveChoice | null;
  /** Curve scale factor relative to the reference, when a proportional scaling was used. */
  factor: number | null;
};

type Hints = Pick<VehicleIdentity, "bodyStyle" | "fuel">;

export type CurveCheck = { ok: true; curve: CurveParams } | { ok: false; curve: CurveParams; message: string };

const fmtRpm = (rpm: number) => `${Math.round(rpm).toLocaleString("en-US")} rpm`;
const differs = (a: number | null, b: number | null) => (a == null || b == null ? a !== b : Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b)));
const pct = (k: number) => `${k >= 1 ? "+" : "−"}${Math.abs((k - 1) * 100).toFixed(1)}%`;

/**
 * The power/torque relationship checks AutoDyn's validation applies, strictly (every stated speed is
 * checked, whatever its provenance): power = torque × ω must be reachable at the power-peak speed and
 * below the redline, and the torque peak must not imply more than the peak power.
 */
export function checkCurve(values: SpecValues, hints: Hints = {}): CurveCheck | null {
  const r = resolveInputs(values, DEFAULT_CONDITIONS, hints);
  if (!r.ok) return null;
  const c = r.inputs.curve;
  const P = c.peakPowerW;
  const T = c.peakTorqueNm;
  if (!(P > 0 && T > 0) || !Number.isFinite(P) || !Number.isFinite(T)) return { ok: false, curve: c, message: "Power and torque must be positive, finite values." };
  const rpmNeeded = radSToRpm(P / T);
  if (rpmNeeded > c.redlineRpm * 1.02) {
    const est = values.redlineRpm.value == null ? " (estimated)" : "";
    return { ok: false, curve: c, message: `this peak torque could only produce the peak power at ${fmtRpm(rpmNeeded)}, above the ${fmtRpm(c.redlineRpm)} redline${est}` };
  }
  if (c.shape !== "electric") {
    if (P / rpmToRadS(c.peakPowerRpm) > T * 1.02) {
      return { ok: false, curve: c, message: `at the ${fmtRpm(c.peakPowerRpm)} power peak the peak power needs more torque than the peak torque allows (it could only be reached at ${fmtRpm(rpmNeeded)})` };
    }
    if (T * rpmToRadS(c.peakTorqueRpm) > P * 1.03) {
      return { ok: false, curve: c, message: `peak torque at the ${fmtRpm(c.peakTorqueRpm)} torque peak would produce more than the peak power` };
    }
  }
  return { ok: true, curve: c };
}

function withDerived(values: SpecValues, derived: DerivedValue[]): SpecValues {
  const out = { ...values };
  for (const d of derived) out[d.key] = { value: d.to, provenance: "estimated", source: MODEL_SOURCE, note: d.reason };
  return out;
}

const torqueScaleReason = (k: number) =>
  `Torque curve scaled ×${k.toFixed(3)} (${pct(k)}) so it produces the requested peak power; torque-peak and power-peak speeds unchanged. Hypothetical — not a measured or published figure.`;
const powerScaleReason = (k: number) =>
  `Power follows the torque curve scaled ×${k.toFixed(3)} (${pct(k)}); torque-peak and power-peak speeds unchanged. Hypothetical — not a measured or published figure.`;

/** Moves the power peak (within the current redline) so a fixed torque ceiling can make the requested power. */
function rpmOption(reference: SpecValues, next: SpecValues, hints: Hints): CurveOption | null {
  const ref = resolveInputs(reference, DEFAULT_CONDITIONS, hints);
  const cur = resolveInputs(next, DEFAULT_CONDITIONS, hints);
  if (!ref.ok || !cur.ok || cur.inputs.curve.shape === "electric") return null;
  const c = cur.inputs.curve;
  const target = Math.ceil(radSToRpm(c.peakPowerW / c.peakTorqueNm) / 50) * 50;
  const redline = next.redlineRpm.value ?? ref.inputs.curve.redlineRpm;
  if (target <= c.peakPowerRpm || target > redline || target < c.peakTorqueRpm) return null;
  const derived: DerivedValue[] = [
    {
      key: "peakPowerRpm",
      from: c.peakPowerRpm,
      to: target,
      reason: `Power peak moved from ${fmtRpm(c.peakPowerRpm)} to ${fmtRpm(target)} so the fixed peak torque can produce the requested power (torque held flat to the new peak). Hypothetical.`,
    },
  ];
  // An estimated redline follows the power peak; keep it where it was so only the power peak moves.
  if (next.redlineRpm.value == null) {
    derived.push({ key: "redlineRpm", from: null, to: Math.round(redline), reason: "Redline kept at its previous estimate so only the power-peak speed changes." });
  }
  const check = checkCurve(withDerived(next, derived), hints);
  return check?.ok ? { id: "rpm", label: `Move the power peak to ${fmtRpm(target)}`, derived } : null;
}

/**
 * Builds the power/torque part of a scenario.
 * @param reference the scenario's values before the request (stock, or the current Modified)
 * @param next      the values with the requested changes applied
 * @param fixed     keys the user stated or fixed for this scenario (never changed automatically)
 * @param choice    a conflict resolution the user approved
 */
export function modelPowerTorque(input: {
  reference: SpecValues;
  next: SpecValues;
  fixed?: ReadonlySet<SpecKey>;
  hints?: Hints;
  choice?: CurveChoice | null;
}): CurveModel {
  const { reference, next, hints = {} } = input;
  const fixed = input.fixed ?? new Set<SpecKey>();
  const base: CurveModel = { status: "unchanged", derived: [], assumption: null, conflict: null, options: [], choice: null, factor: null };
  const Pr = reference.peakPowerKw.value;
  const Pn = next.peakPowerKw.value;
  const Tr = reference.peakTorqueNm.value;
  const Tn = next.peakTorqueNm.value;
  if (Pr == null || Pn == null || !(Pr > 0) || !(Pn > 0) || !Number.isFinite(Pn)) return base;
  if (Tn != null && !(Tn > 0 && Number.isFinite(Tn))) return base; // validation reports invalid torque
  const powerChanged = differs(Pn, Pr);
  const torqueChanged = differs(Tn, Tr);
  if (!powerChanged && !torqueChanged) return base;

  const torqueLocked = torqueChanged || fixed.has("peakTorqueNm");
  const powerLocked = powerChanged || fixed.has("peakPowerKw");

  // Only one of power/torque requested, the other free: scale the whole curve.
  if (Tr != null && Tr > 0) {
    let derived: DerivedValue[] | null = null;
    let k = 1;
    if (powerChanged && !torqueLocked) {
      k = Pn / Pr;
      derived = [{ key: "peakTorqueNm", from: Tn, to: Tr * k, reason: torqueScaleReason(k) }];
    } else if (torqueChanged && !powerLocked && Tn != null) {
      k = Tn / Tr;
      derived = [{ key: "peakPowerKw", from: Pn, to: Pr * k, reason: powerScaleReason(k) }];
    }
    if (derived) {
      const check = checkCurve(withDerived(next, derived), hints);
      const assumption =
        derived[0].key === "peakTorqueNm"
          ? `Only power was specified, so AutoDyn scaled the whole torque curve by the same ${pct(k)} (rpm positions unchanged). Estimated, hypothetical curve.`
          : `Only torque was specified, so AutoDyn scaled the whole curve by the same ${pct(k)} — peak power changes with it (rpm positions unchanged). Estimated, hypothetical curve.`;
      if (check && !check.ok) return { ...base, status: "conflict", assumption, conflict: `Even with the curve scaled, ${check.message}.`, factor: k };
      return { ...base, status: "derived", derived, assumption, factor: k };
    }
  }

  // Stated values only: they must already be compatible, or the user picks an explicit resolution.
  const check = checkCurve(next, hints);
  if (!check || check.ok) {
    return {
      ...base,
      status: "consistent",
      assumption: powerChanged && torqueChanged ? "Both power and torque are as stated; the torque-peak and power-peak speeds are unchanged and compatible with them." : null,
    };
  }
  const options: CurveOption[] = [];
  if (Tr != null && Tr > 0 && powerChanged && !torqueChanged) {
    const k = Pn / Pr;
    options.push({ id: "scale", label: `Scale the torque curve with power (${pct(k)}) instead of keeping peak torque`, derived: [{ key: "peakTorqueNm", from: Tn, to: Tr * k, reason: torqueScaleReason(k) }] });
  } else if (Tr != null && Tr > 0 && Tn != null && torqueChanged && !powerChanged) {
    const k = Tn / Tr;
    options.push({ id: "scale", label: `Scale peak power with the torque curve (${pct(k)}) instead of keeping it`, derived: [{ key: "peakPowerKw", from: Pn, to: Pr * k, reason: powerScaleReason(k) }] });
  }
  if (!fixed.has("peakPowerRpm") && !differs(next.peakPowerRpm.value, reference.peakPowerRpm.value)) {
    const o = rpmOption(reference, next, hints);
    if (o) options.push(o);
  }
  const conflict = `The requested values are incompatible: ${check.message}.`;
  const chosen = options.find((o) => o.id === input.choice);
  if (chosen) {
    const after = checkCurve(withDerived(next, chosen.derived), hints);
    if (after?.ok) return { ...base, status: "derived", derived: chosen.derived, assumption: chosen.derived[0].reason, options, choice: chosen.id, conflict };
  }
  return { ...base, status: "conflict", conflict, options };
}

/** Values with the derived ones applied as estimates (for previews and checks). */
export function applyDerived(values: SpecValues, derived: DerivedValue[]): SpecValues {
  return withDerived(values, derived);
}

/** Manual Setup suggestion: values to derive (applied as estimates) and stale modeled values to return to stock. */
export type RelatedSuggestion = { model: CurveModel; derived: DerivedValue[]; reset: CurveKey[] };

/**
 * Manual Setup's "Adjust related values": the same model the AI proposal pipeline uses, applied to
 * the Modified scenario as it stands. Values AutoDyn modeled earlier are re-derived from stock;
 * values the user entered for Modified are kept fixed. Null when there is nothing to suggest.
 */
export function relatedValues(stock: SpecValues, modified: SpecValues, hints: Hints = {}): RelatedSuggestion | null {
  const modeled = CURVE_KEYS.filter((k) => modified[k].source === MODEL_SOURCE);
  const next = { ...modified };
  for (const k of modeled) next[k] = stock[k];
  const isOverride = (k: CurveKey) => modified[k] !== stock[k] && (differs(modified[k].value, stock[k].value) || modified[k].provenance !== stock[k].provenance);
  const fixed = new Set<SpecKey>(CURVE_KEYS.filter((k) => isOverride(k) && modified[k].provenance === "user"));
  const model = modelPowerTorque({ reference: stock, next, fixed, hints });
  const derived = model.status === "derived" ? model.derived.filter((d) => modified[d.key].source !== MODEL_SOURCE || differs(modified[d.key].value, d.to)) : [];
  // Values modeled earlier that the current inputs no longer call for go back to stock.
  const reset = model.status === "derived" || model.status === "unchanged" ? modeled.filter((k) => !model.derived.some((d) => d.key === k)) : [];
  return derived.length || reset.length ? { model, derived, reset } : null;
}
