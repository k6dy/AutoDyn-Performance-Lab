import type { Provenance, SpecKey } from "@/lib/domain/types";
import type { AnalysisResult, ScenarioResult } from "@/lib/physics/analysis";
import type { RunMetrics } from "@/lib/physics/simulate";
import { kgToLb, kwToHp, toDisplay, unitLabel, type Quantity, type UnitSystem } from "@/lib/units";

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
  stockSource: Provenance | "calculated" | null;
  modifiedSource: Provenance | "calculated" | null;
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
};

const q = (quantity: Quantity) => (u: UnitSystem) => unitLabel(quantity, u);

const DEFS: Def[] = [
  { id: "power", label: () => "Peak power", input: "peakPowerKw", unit: q("power"), digits: 0, better: "higher", value: (r, _m, u) => toDisplay("power", r.inputs.curve.peakPowerW / 1000, u) },
  { id: "torque", label: () => "Peak torque", input: "peakTorqueNm", unit: q("torque"), digits: 0, better: "higher", value: (r, _m, u) => toDisplay("torque", r.inputs.curve.peakTorqueNm, u) },
  { id: "mass", label: () => "Test mass", input: "curbMassKg", unit: q("mass"), digits: 0, better: "lower", value: (r, _m, u) => toDisplay("mass", r.inputs.massKg, u) },
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

export function metricRows(result: AnalysisResult, units: UnitSystem): MetricRow[] {
  const finite = (v: number | null) => (v != null && Number.isFinite(v) ? v : null);
  const range = (r: ScenarioResult, d: Def): [number | null, number | null] | null =>
    d.ranged ? [finite(d.value(r, r.range.optimistic, units)), finite(d.value(r, r.range.conservative, units))] : null;
  const source = (r: ScenarioResult, d: Def): MetricRow["stockSource"] => (d.input ? (r.provenance[d.input] ?? null) : "calculated");
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
    kind: d.input ? "input" : "calculated",
    stockSource: source(result.stock, d),
    modifiedSource: result.modified ? source(result.modified, d) : null,
  }));
}

export function rowDelta(row: MetricRow) {
  if (row.stock == null || row.modified == null) return null;
  const abs = row.modified - row.stock;
  const rel = row.stock !== 0 ? (abs / row.stock) * 100 : null;
  const improved = row.better == null || Math.abs(abs) < 1e-9 ? null : row.better === "lower" ? abs < 0 : abs > 0;
  return { abs, rel, improved };
}
