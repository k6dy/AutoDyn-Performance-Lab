import { PROVENANCE_LABEL, type Provenance, type SpecKey } from "@/lib/domain/types";
import type { AnalysisResult, ScenarioResult } from "@/lib/physics/analysis";
import type { RunMetrics } from "@/lib/physics/simulate";
import { kgToLb, kwToHp, toDisplay, unitLabel, type Quantity, type UnitSystem } from "@/lib/units";

/**
 * Where a displayed figure comes from:
 *  - a Provenance: a specification shown as entered/sourced (verified, user, estimated, unavailable);
 *  - derived: an input AutoDyn combines from several specifications (test mass = curb weight +
 *    driver & cargo), so its reliability is that of its least reliable component;
 *  - calculated: a simulated output of the physics engine.
 */
export type MetricSource = Provenance | "derived" | "calculated";

export type MetricRow = {
  id: string;
  label: string;
  unit: string;
  digits: number;
  better: "lower" | "higher" | null;
  stock: number | null;
  stockRange: [number | null, number | null] | null;
  modified: number | null;
  modifiedRange: [number | null, number | null] | null;
  note?: string;
  /** input: a simulation input shown for reference (with its provenance) · calculated: a simulated output. */
  kind: "input" | "calculated";
  stockSource: MetricSource | null;
  modifiedSource: MetricSource | null;
  /** For derived inputs: the components and their sources, e.g. "curb weight (verified) + driver & cargo (estimated)". */
  stockBasis: string | null;
  modifiedBasis: string | null;
};

type Def = {
  id: string;
  label: (u: UnitSystem) => string;
  unit: (u: UnitSystem) => string;
  digits: number;
  better: MetricRow["better"];
  value: (r: ScenarioResult, m: RunMetrics, u: UnitSystem) => number | null;
  ranged?: boolean;
  note?: string;
  /** The specification an input row shows (its provenance travels with it). */
  input?: SpecKey;
  /** An input combined from these specifications (shown as derived, never as verified). */
  derivedFrom?: { key: SpecKey; label: string }[];
};

const q = (quantity: Quantity) => (u: UnitSystem) => unitLabel(quantity, u);

const MASS_COMPONENTS: { key: SpecKey; label: string }[] = [
  { key: "curbMassKg", label: "curb weight" },
  { key: "payloadKg", label: "driver & cargo" },
];

const DEFS: Def[] = [
  { id: "power", label: () => "Peak power", input: "peakPowerKw", unit: q("power"), digits: 0, better: "higher", value: (r, _m, u) => toDisplay("power", r.inputs.curve.peakPowerW / 1000, u) },
  { id: "torque", label: () => "Peak torque", input: "peakTorqueNm", unit: q("torque"), digits: 0, better: "higher", value: (r, _m, u) => toDisplay("torque", r.inputs.curve.peakTorqueNm, u) },
  { id: "curb", label: () => "Curb weight", input: "curbMassKg", unit: q("mass"), digits: 0, better: "lower", value: (r, _m, u) => toDisplay("mass", r.inputs.curbMassKg, u) },
  { id: "payload", label: () => "Driver & cargo", input: "payloadKg", unit: q("mass"), digits: 0, better: "lower", value: (r, _m, u) => toDisplay("mass", r.inputs.payloadKg, u) },
  {
    id: "mass",
    label: () => "Test mass",
    derivedFrom: MASS_COMPONENTS,
    unit: q("mass"),
    digits: 0,
    better: "lower",
    value: (r, _m, u) => toDisplay("mass", r.inputs.massKg, u),
    note: "Curb weight + driver & cargo — the mass the simulation accelerates",
  },
  {
    id: "ptw",
    label: (u) => (u === "imperial" ? "Weight-to-power" : "Power-to-weight"),
    unit: (u) => (u === "imperial" ? "lb/hp" : "kW/t"),
    digits: 1,
    better: null,
    value: (r, _m, u) =>
      u === "imperial"
        ? kgToLb(r.inputs.massKg) / kwToHp(r.inputs.curve.peakPowerW / 1000)
        : r.inputs.curve.peakPowerW / r.inputs.massKg,
    note: "Uses the test mass",
  },
  { id: "060", label: () => "0–60 mph", unit: () => "s", digits: 2, better: "lower", value: (_r, m) => m.zeroTo60S, ranged: true },
  { id: "0100k", label: () => "0–100 km/h", unit: () => "s", digits: 2, better: "lower", value: (_r, m) => m.zeroTo100KphS, ranged: true },
  { id: "0100m", label: () => "0–100 mph", unit: () => "s", digits: 1, better: "lower", value: (_r, m) => m.zeroTo100MphS, ranged: true },
  { id: "qm", label: () => "Quarter mile", unit: () => "s", digits: 2, better: "lower", value: (_r, m) => m.quarterMileS, ranged: true },
  { id: "trap", label: () => "Quarter-mile trap", unit: q("speed"), digits: 1, better: "higher", value: (_r, m, u) => (m.quarterMileTrapMs ? toDisplay("speed", m.quarterMileTrapMs, u) : null), ranged: true },
  { id: "5070", label: () => "50–70 mph (full throttle)", unit: () => "s", digits: 2, better: "lower", value: (_r, m) => m.fiftyToSeventyS, ranged: true },
  { id: "peakg", label: () => "Peak acceleration", unit: () => "g", digits: 2, better: "higher", value: (_r, m) => m.peakAccelG },
  { id: "traction", label: () => "Traction-limited share of 0–60", unit: () => "%", digits: 0, better: null, value: (_r, m) => (m.tractionShareTo60 == null ? null : m.tractionShareTo60 * 100) },
  {
    id: "top",
    label: () => "Theoretical top speed",
    unit: q("speed"),
    digits: 0,
    better: "higher",
    value: (_r, m, u) => (m.topSpeedMs ? toDisplay("speed", m.topSpeedMs, u) : null),
    ranged: true,
    note: "Ignores electronic limiters",
  },
];

/**
 * Provenance of one specification in a scenario result. The stored provenance map is authoritative;
 * a value the resolver filled in (listed in `estimates`) is an estimate even if the map predates it.
 */
export function inputProvenance(r: ScenarioResult, key: SpecKey): Provenance {
  const p = r.provenance[key];
  if (p) return p;
  return r.estimates.some((e) => e.key === key) ? "estimated" : "unavailable";
}

/** "curb weight (verified) + driver & cargo (estimated)" — the components of a derived input and their sources. */
export function derivedBasis(r: ScenarioResult, components: { key: SpecKey; label: string }[]): string {
  return components.map((c) => `${c.label} (${PROVENANCE_LABEL[inputProvenance(r, c.key)].toLowerCase()})`).join(" + ");
}

export const massBasis = (r: ScenarioResult) => derivedBasis(r, MASS_COMPONENTS);

export function metricRows(result: AnalysisResult, units: UnitSystem): MetricRow[] {
  const finite = (v: number | null) => (v != null && Number.isFinite(v) ? v : null);
  const range = (r: ScenarioResult, d: Def): [number | null, number | null] | null =>
    d.ranged ? [finite(d.value(r, r.range.optimistic, units)), finite(d.value(r, r.range.conservative, units))] : null;
  const source = (r: ScenarioResult, d: Def): MetricSource => (d.input ? inputProvenance(r, d.input) : d.derivedFrom ? "derived" : "calculated");
  const basis = (r: ScenarioResult, d: Def) => (d.derivedFrom ? derivedBasis(r, d.derivedFrom) : null);
  return DEFS.map((d) => ({
    id: d.id,
    label: d.label(units),
    unit: d.unit(units),
    digits: d.digits,
    better: d.better,
    note: d.note,
    stock: finite(d.value(result.stock, result.stock.metrics, units)),
    stockRange: range(result.stock, d),
    modified: result.modified ? finite(d.value(result.modified, result.modified.metrics, units)) : null,
    modifiedRange: result.modified ? range(result.modified, d) : null,
    kind: d.input || d.derivedFrom ? "input" : "calculated",
    stockSource: source(result.stock, d),
    modifiedSource: result.modified ? source(result.modified, d) : null,
    stockBasis: basis(result.stock, d),
    modifiedBasis: result.modified ? basis(result.modified, d) : null,
  }));
}

/** Rounds to the row's displayed precision, so differences are taken between the figures a reader sees. */
export const roundTo = (v: number, digits: number) => {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
};

/**
 * Stock → Modified difference for a row. Rounding policy: both values are first rounded to the
 * precision the table displays, so the difference always equals the displayed Modified figure
 * minus the displayed Stock figure (6.19 s → 5.05 s reads −1.14 s, never −1.15 s from unrounded
 * internals). The percentage uses the same rounded figures. Internal physics precision is untouched.
 */
export function rowDelta(row: MetricRow) {
  if (row.stock == null || row.modified == null) return null;
  const stock = roundTo(row.stock, row.digits);
  const modified = roundTo(row.modified, row.digits);
  const abs = roundTo(modified - stock, row.digits);
  const rel = stock !== 0 ? (abs / stock) * 100 : null;
  const improved = row.better == null || Math.abs(abs) < 1e-9 ? null : row.better === "lower" ? abs < 0 : abs > 0;
  return { abs, rel, improved };
}
