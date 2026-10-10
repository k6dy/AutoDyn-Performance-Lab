// Runs the deterministic engine for each scenario and derives comparison data.
// Nothing here calls an AI model; both Manual Setup and the AI Build Assistant end up here.

import { QUALITY_WEIGHTS } from "@/lib/domain/fields";
import { effectiveConstraints, effectiveValues, modifiedDiff } from "@/lib/domain/scenario";
import { assessScenario } from "@/lib/feasibility/assess";
import type { FeasibilityAssessment } from "@/lib/feasibility/types";
import type {
  AnalysisConfig,
  Conditions,
  Provenance,
  ScenarioId,
  SpecKey,
  SpecValues,
  VehicleIdentity,
} from "@/lib/domain/types";
import { sampleCurve, type CurvePoint } from "@/lib/physics/curve";
import { resolveInputs, type EstimateNote, type ResolvedInputs } from "@/lib/physics/resolve";
import { simulateRun, type RunMetrics, type Sample } from "@/lib/physics/simulate";

// 2.1.0: threshold crossings interpolated within the integration step; sensitivity direction labels.
export const ENGINE_VERSION = "autodyn-physics/2.1.0";

export type DataQuality = {
  score: number;
  level: "High" | "Moderate" | "Low";
  counts: Record<Provenance, number>;
};

export type SensitivityItem = {
  id: string;
  label: string;
  change: string;
  /** The two perturbations, e.g. "−10% curb mass" (usually helps) and "+10% curb mass". */
  favorableLabel: string;
  unfavorableLabel: string;
  /** Change in 0–60 time (s) for the usually-favorable / usually-unfavorable direction. */
  favorable060: number | null;
  unfavorable060: number | null;
  favorableEt: number | null;
  unfavorableEt: number | null;
  /** Deterministic explanation when the effect is negligible or opposite to the usual direction. */
  note: string | null;
};

export type SweepPoint = { deltaPct: number; massKg: number; zeroTo60S: number | null; quarterMileS: number | null };

export type ScenarioResult = {
  scenario: ScenarioId;
  inputs: ResolvedInputs;
  estimates: EstimateNote[];
  provenance: Partial<Record<SpecKey, Provenance>>;
  metrics: RunMetrics;
  range: { conservative: RunMetrics; optimistic: RunMetrics };
  samples: Sample[];
  curve: CurvePoint[];
  sensitivity: SensitivityItem[];
  massSweep: SweepPoint[];
  quality: DataQuality;
  powerToWeightWkg: number;
};

export type AttributionItem = {
  group: string;
  label: string;
  keys: SpecKey[];
  delta060: number | null;
  deltaEt: number | null;
  deltaTrapMs: number | null;
};

export type AnalysisResult = {
  id: string;
  createdAt: string;
  engineVersion: string;
  identity: VehicleIdentity;
  conditions: Conditions;
  config: AnalysisConfig;
  stock: ScenarioResult;
  modified: ScenarioResult | null;
  /** Effect of each changed parameter group applied to stock alone (only when modified exists). */
  attribution: AttributionItem[] | null;
  /** Deterministic engineering feasibility for each scenario (independent of any AI). */
  feasibility: { stock: FeasibilityAssessment; modified: FeasibilityAssessment | null };
};

const GROUPS: { group: string; label: string; keys: SpecKey[] }[] = [
  { group: "output", label: "Power & torque", keys: ["peakPowerKw", "peakTorqueNm", "peakPowerRpm", "peakTorqueRpm", "redlineRpm", "aspiration", "powertrain"] },
  { group: "mass", label: "Mass", keys: ["curbMassKg", "payloadKg"] },
  { group: "aero", label: "Aerodynamics", keys: ["dragCoefficient", "frontalAreaM2"] },
  { group: "grip", label: "Tires & traction", keys: ["tireMu", "tireRadiusM", "frontWeightFraction", "cgHeightRatio", "rollingResistance"] },
  { group: "driveline", label: "Drivetrain & gearing", keys: ["drivetrain", "drivetrainEfficiency", "transmission", "gearCount", "gearRatios", "finalDrive", "shiftTimeS"] },
];

function attribute(config: AnalysisConfig, changed: SpecKey[]): AttributionItem[] {
  const stock = config.stock!;
  const base = resolveInputs(stock.values, config.conditions, stock.identity);
  if (!base.ok) return [];
  const baseRun = quick(base.inputs, config.conditions.rollout);
  const items: AttributionItem[] = [];
  for (const g of GROUPS) {
    const keys = g.keys.filter((k) => changed.includes(k));
    if (!keys.length) continue;
    const values = { ...stock.values };
    const mod = effectiveValues(config, "modified")!;
    for (const k of keys) (values as Record<string, unknown>)[k] = mod[k];
    const r = resolveInputs(values as SpecValues, config.conditions, stock.identity);
    if (!r.ok) continue;
    const run = quick(r.inputs, config.conditions.rollout);
    items.push({
      group: g.group,
      label: g.label,
      keys,
      delta060: diff(run.zeroTo60S, baseRun.zeroTo60S),
      deltaEt: diff(run.quarterMileS, baseRun.quarterMileS),
      deltaTrapMs: diff(run.quarterMileTrapMs, baseRun.quarterMileTrapMs),
    });
  }
  return items;
}

const PROVENANCE_SCORE: Record<Provenance, number> = { verified: 1, user: 0.85, estimated: 0.45, unavailable: 0 };

function provenanceMap(values: SpecValues, estimates: EstimateNote[]) {
  const map: Partial<Record<SpecKey, Provenance>> = {};
  for (const key of Object.keys(values) as SpecKey[]) {
    map[key] = values[key].value == null ? "unavailable" : values[key].provenance;
  }
  for (const e of estimates) if (e.key !== "launchRpm") map[e.key] = "estimated";
  return map;
}

function quality(map: Partial<Record<SpecKey, Provenance>>): DataQuality {
  const counts: Record<Provenance, number> = { verified: 0, user: 0, estimated: 0, unavailable: 0 };
  let total = 0;
  let weight = 0;
  for (const [key, w] of Object.entries(QUALITY_WEIGHTS) as [SpecKey, number][]) {
    const p = map[key] ?? "unavailable";
    counts[p] += 1;
    total += w * PROVENANCE_SCORE[p];
    weight += w;
  }
  const score = weight ? total / weight : 0;
  return { score, level: score >= 0.8 ? "High" : score >= 0.6 ? "Moderate" : "Low", counts };
}

type Perturb = (inp: ResolvedInputs, sign: 1 | -1) => ResolvedInputs;

function scaleCurve(inp: ResolvedInputs, powerScale: number, torqueScale: number): ResolvedInputs {
  return {
    ...inp,
    curve: { ...inp.curve, peakPowerW: inp.curve.peakPowerW * powerScale, peakTorqueNm: inp.curve.peakTorqueNm * torqueScale },
  };
}

function withMass(inp: ResolvedInputs, curbMassKg: number): ResolvedInputs {
  return { ...inp, curbMassKg, massKg: curbMassKg + inp.payloadKg };
}

/** Input uncertainty by provenance: (relative or absolute) half-range. sign=+1 → conservative. */
function uncertaintyPerturbation(map: Partial<Record<SpecKey, Provenance>>): Perturb {
  const rel = (key: SpecKey, verified: number, user: number, estimated: number) => {
    const p = map[key];
    return p === "estimated" ? estimated : p === "user" ? user : verified;
  };
  return (inp, sign) => {
    const powerU = rel("peakPowerKw", 0.03, 0.05, 0.05);
    const torqueU = rel("peakTorqueNm", 0.03, 0.05, 0.12);
    let out = scaleCurve(inp, 1 - sign * powerU, 1 - sign * torqueU);
    out = withMass(out, inp.curbMassKg * (1 + sign * rel("curbMassKg", 0.02, 0.02, 0.05)));
    return {
      ...out,
      dragCoefficient: inp.dragCoefficient * (1 + sign * rel("dragCoefficient", 0.03, 0.03, 0.1)),
      frontalAreaM2: inp.frontalAreaM2 * (1 + sign * rel("frontalAreaM2", 0.03, 0.03, 0.08)),
      drivetrainEfficiency: Math.min(0.99, inp.drivetrainEfficiency - sign * rel("drivetrainEfficiency", 0.01, 0.01, 0.03)),
      tireMu: Math.max(0.1, inp.tireMu - sign * rel("tireMu", 0.05, 0.05, 0.1)),
      rollingResistance: inp.rollingResistance * (1 + sign * rel("rollingResistance", 0.1, 0.1, 0.25)),
      shiftTimeS: Math.max(0, inp.shiftTimeS * (1 + sign * rel("shiftTimeS", 0.2, 0.2, 0.5))),
    };
  };
}

type SensitivityDef = { id: string; label: string; change: string; plus: string; minus: string; apply: Perturb };

const SENSITIVITY: SensitivityDef[] = [
  { id: "output", label: "Engine output", change: "±10% power and torque", plus: "+10% power and torque", minus: "−10% power and torque", apply: (i, s) => scaleCurve(i, 1 + 0.1 * s, 1 + 0.1 * s) },
  { id: "mass", label: "Vehicle mass", change: "∓10% curb mass", plus: "−10% curb mass", minus: "+10% curb mass", apply: (i, s) => withMass(i, i.curbMassKg * (1 - 0.1 * s)) },
  { id: "grip", label: "Tire friction", change: "±10% μ", plus: "+10% tire μ", minus: "−10% tire μ", apply: (i, s) => ({ ...i, tireMu: i.tireMu * (1 + 0.1 * s) }) },
  { id: "drag", label: "Aerodynamic drag", change: "∓10% Cd·A", plus: "−10% Cd·A", minus: "+10% Cd·A", apply: (i, s) => ({ ...i, dragCoefficient: i.dragCoefficient * (1 - 0.1 * s) }) },
  {
    id: "efficiency",
    label: "Drivetrain efficiency",
    change: "±3 points",
    plus: "+3 points efficiency",
    minus: "−3 points efficiency",
    apply: (i, s) => ({ ...i, drivetrainEfficiency: Math.min(0.99, i.drivetrainEfficiency + 0.03 * s) }),
  },
  { id: "gearing", label: "Final drive", change: "±10% ratio", plus: "+10% final drive (shorter)", minus: "−10% final drive (taller)", apply: (i, s) => ({ ...i, finalDrive: i.finalDrive * (1 + 0.1 * s) }) },
  { id: "shift", label: "Shift time", change: "∓50%", plus: "−50% shift time", minus: "+50% shift time", apply: (i, s) => ({ ...i, shiftTimeS: i.shiftTimeS * (1 - 0.5 * s) }) },
];

/** Effects below this (s) are reported as no measurable change. */
const NEGLIGIBLE_S = 0.005;

/**
 * Why a sensitivity is flat or runs opposite to intuition — derived only from the simulated runs,
 * so a zero bar is explained by the model rather than looking like a missing calculation.
 */
function sensitivityNote(id: string, fav: RunMetrics, unfav: RunMetrics, base: RunMetrics): string | null {
  const d = (x: RunMetrics) => (x.zeroTo60S == null || base.zeroTo60S == null ? null : x.zeroTo60S - base.zeroTo60S);
  const df = d(fav);
  const du = d(unfav);
  if (df == null || du == null) return null;
  const share = base.tractionShareTo60 ?? 0;
  const pct = `${Math.round(share * 100)}%`;
  if (Math.abs(df) < NEGLIGIBLE_S && Math.abs(du) < NEGLIGIBLE_S) {
    if ((id === "output" || id === "efficiency") && share >= 0.8)
      return `No measurable effect: the run is traction-limited for ${pct} of 0–60 mph, so tire grip, not engine output, sets the acceleration.`;
    if (id === "mass" && share >= 0.8)
      return "Almost no effect: while traction-limited, available grip scales with vehicle weight, so the mass change largely cancels out (only drag and rolling resistance remain).";
    if (id === "drag") return "Negligible: aerodynamic drag is small below 60 mph.";
    return "No measurable effect on 0–60 mph in this model.";
  }
  if (df > NEGLIGIBLE_S) {
    if (fav.shiftsTo60 > base.shiftsTo60) return "The usually helpful direction is slower here: it adds an upshift before 60 mph.";
    if (id === "mass" && share >= 0.8) return "Lighter is not quicker here: while traction-limited, less weight also means less grip, and drag stays the same.";
    return "The usually helpful direction is slower in this configuration.";
  }
  if (du < -NEGLIGIBLE_S && unfav.shiftsTo60 < base.shiftsTo60) return "The usually unfavorable direction is quicker here: it saves an upshift before 60 mph.";
  return null;
}

const quick = (inp: ResolvedInputs, rollout: boolean, top = false) =>
  simulateRun(inp, { collectSamples: false, rollout, dt: 0.005, topSpeed: top }).metrics;
const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : a - b);

function runScenario(
  values: SpecValues,
  scenario: ScenarioId,
  identity: VehicleIdentity,
  conditions: Conditions,
): ScenarioResult {
  const resolved = resolveInputs(values, conditions, identity);
  if (!resolved.ok) throw new Error(`Missing required inputs: ${resolved.missing.join(", ")}`);
  const { inputs, estimates } = resolved;
  const map = provenanceMap(values, estimates);
  const nominal = simulateRun(inputs, { rollout: conditions.rollout });
  const perturb = uncertaintyPerturbation(map);
  const conservative = quick(perturb(inputs, 1), conditions.rollout, true);
  const optimistic = quick(perturb(inputs, -1), conditions.rollout, true);

  const base = quick(inputs, conditions.rollout);
  const sensitivity = SENSITIVITY.filter((s) => !(s.id === "shift" && inputs.shiftTimeS === 0)).map((s) => {
    const up = quick(s.apply(inputs, 1), conditions.rollout);
    const down = quick(s.apply(inputs, -1), conditions.rollout);
    return {
      id: s.id,
      label: s.label,
      change: s.change,
      favorableLabel: s.plus,
      unfavorableLabel: s.minus,
      note: sensitivityNote(s.id, up, down, base),
      favorable060: diff(up.zeroTo60S, base.zeroTo60S),
      unfavorable060: diff(down.zeroTo60S, base.zeroTo60S),
      favorableEt: diff(up.quarterMileS, base.quarterMileS),
      unfavorableEt: diff(down.quarterMileS, base.quarterMileS),
    };
  });

  const massSweep: SweepPoint[] = [-20, -15, -10, -5, 0, 5, 10, 15, 20].map((pct) => {
    const massKg = inputs.curbMassKg * (1 + pct / 100);
    const r = pct === 0 ? base : quick(withMass(inputs, massKg), conditions.rollout);
    return { deltaPct: pct, massKg, zeroTo60S: r.zeroTo60S, quarterMileS: r.quarterMileS };
  });

  return {
    scenario,
    inputs,
    estimates,
    provenance: map,
    metrics: nominal.metrics,
    range: { conservative, optimistic },
    samples: nominal.samples,
    curve: sampleCurve({ ...inputs.curve, peakPowerW: inputs.curve.peakPowerW }),
    sensitivity,
    massSweep,
    quality: quality(map),
    powerToWeightWkg: inputs.curve.peakPowerW / inputs.massKg,
  };
}

export function runAnalysis(config: AnalysisConfig, now = new Date()): AnalysisResult {
  if (!config.stock) throw new Error("No vehicle configured.");
  const identity = config.stock.identity;
  const stockValues = effectiveValues(config, "stock")!;
  const stock = runScenario(stockValues, "stock", identity, config.conditions);
  const modified = config.modified
    ? runScenario(effectiveValues(config, "modified")!, "modified", identity, config.conditions)
    : null;
  return {
    id: `run-${now.getTime().toString(36)}`,
    createdAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    identity,
    conditions: config.conditions,
    config: structuredClone(config),
    stock,
    modified,
    attribution: modified ? attribute(config, modifiedDiff(config)) : null,
    feasibility: {
      stock: assessScenario({ scenario: "stock", values: stockValues, identity, constraints: effectiveConstraints(config, "stock"), rollout: config.conditions.rollout, result: stock }),
      modified: modified
        ? assessScenario({
            scenario: "modified",
            values: effectiveValues(config, "modified")!,
            identity,
            constraints: effectiveConstraints(config, "modified"),
            rollout: config.conditions.rollout,
            result: modified,
            stock,
          })
        : null,
    },
  };
}
