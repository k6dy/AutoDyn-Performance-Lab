// Independent checks of the physics engine: dimensional identities, reference constants, ordering
// invariants and robustness at the input bounds. Expected values are computed by hand or from
// published constants — never by running the engine and copying its output.
import { describe, expect, it } from "vitest";
import { applyProposal } from "@/lib/ai/apply";
import { metricRows, rowDelta, type MetricRow } from "@/lib/analysis/metrics";
import { emptySpecValues } from "@/lib/domain/fields";
import { DEFAULT_CONDITIONS, type SpecValues } from "@/lib/domain/types";
import { validateConditions, validateConfig, validateValues } from "@/lib/domain/validation";
import { launchAccelBound } from "@/lib/feasibility/bounds";
import { runAnalysis } from "@/lib/physics/analysis";
import { airDensity, powerCorrectionFactor, pressureAtElevation } from "@/lib/physics/atmosphere";
import { sampleCurve, torqueAt } from "@/lib/physics/curve";
import { resolveInputs, type ResolvedInputs } from "@/lib/physics/resolve";
import { resistance, simulateRun, tractionLimit } from "@/lib/physics/simulate";
import { G, hpToKw, KG_PER_LB, lbftToNm, lbToKg, mphToMs, NM_PER_LBFT, QUARTER_MILE_M, rpmToRadS, W_PER_HP } from "@/lib/units";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";
import { c300, config } from "./support/fixtures";

const resolved = (values: SpecValues = c300().values): ResolvedInputs => {
  const r = resolveInputs(values, DEFAULT_CONDITIONS, { bodyStyle: "Sedan", fuel: "gas" });
  if (!r.ok) throw new Error(`unresolved: ${r.missing.join(",")}`);
  return r.inputs;
};

const finiteOrNull = (v: unknown) => v == null || (typeof v === "number" && Number.isFinite(v));

describe("power/torque identity and the synthesized curve", () => {
  it("HP = torque(lb·ft) × rpm ÷ 5252 holds at the power peak, using published constants only", () => {
    const inp = resolved();
    const { curve } = inp;
    const torqueLbft = torqueAt(curve, curve.peakPowerRpm) / NM_PER_LBFT;
    const hp = (torqueLbft * curve.peakPowerRpm) / 5252;
    expect(hp).toBeCloseTo(241, 0);
    expect(Math.abs(hp - 241) / 241).toBeLessThan(0.005);
    // 5252 is not a magic number: it is 33,000 ft·lbf/min ÷ 2π, i.e. 1 hp = 1 lb·ft × 5252 rpm.
    expect(NM_PER_LBFT * rpmToRadS(5252)).toBeCloseTo(W_PER_HP, 0);
  });

  it("the curve never exceeds the stated peaks: T(rpm) ≤ peak torque and T·ω ≤ peak power at every rpm", () => {
    const { curve } = resolved();
    expect(curve.peakTorqueRpm).toBe(1300);
    expect(curve.peakPowerRpm).toBe(5550);
    const points = sampleCurve(curve, 400);
    let maxPowerW = 0;
    let maxTorque = 0;
    for (const p of points) {
      const powerW = p.torqueNm * rpmToRadS(p.rpm);
      expect(p.torqueNm).toBeLessThanOrEqual(curve.peakTorqueNm * (1 + 1e-9));
      expect(powerW).toBeLessThanOrEqual(curve.peakPowerW * (1 + 1e-9));
      maxPowerW = Math.max(maxPowerW, powerW);
      maxTorque = Math.max(maxTorque, p.torqueNm);
    }
    expect(maxPowerW / curve.peakPowerW).toBeGreaterThan(0.995);
    expect(maxTorque).toBeCloseTo(curve.peakTorqueNm, 6);
    expect(torqueAt(curve, curve.peakTorqueRpm)).toBeCloseTo(lbftToNm(273), 6);
    expect(torqueAt(curve, curve.redlineRpm + 500)).toBe(0);
  });

  it("a proportionally scaled modified curve reaches its requested target within 0.5%", () => {
    const trim = allDatasetTrims().find((t) => t.year === 2015 && /^C 300 4MATIC 4dr/.test(t.description ?? ""))!;
    const vehicle = datasetSpecSet(trim);
    const proposal = {
      id: "p",
      intent: "modify" as const,
      vehicle: { kind: "load" as const, label: "2015 Mercedes-Benz C300 4MATIC", specSet: vehicle, note: "" },
      rejected: [],
      view: "compare" as const,
      runAfterApply: true,
      changes: [{ id: "c0", target: "modified" as const, key: "peakPowerKw" as const, op: "add" as const, value: hpToKw(60), display: "+60 hp", reason: "add 60 hp", statedByUser: true }],
    };
    const cfg = applyProposal({ stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } }, proposal, { selected: { c0: true } }).config;
    const result = runAnalysis(cfg);
    const curve = result.modified!.inputs.curve;
    const maxPowerW = Math.max(...sampleCurve(curve, 400).map((p) => p.torqueNm * rpmToRadS(p.rpm)));
    expect(Math.abs(maxPowerW / (hpToKw(301) * 1000) - 1)).toBeLessThan(0.005);
    expect(result.stock.inputs.curve.peakPowerW).toBeCloseTo(hpToKw(241) * 1000, 3); // stock untouched
    expect(result.modified!.provenance.peakTorqueNm).toBe("estimated");
  });
});

describe("dimensional checks and reference constants", () => {
  it("unit constants match their definitions", () => {
    expect(W_PER_HP).toBeCloseTo(745.7, 1);
    expect(NM_PER_LBFT).toBeCloseTo(1.35582, 5);
    expect(KG_PER_LB).toBe(0.45359237);
    expect(mphToMs(60)).toBeCloseTo(26.8224, 4);
    expect(QUARTER_MILE_M).toBeCloseTo(1609.344 / 4, 3);
    expect(G).toBe(9.80665);
  });

  it("resistance is ½ρC_dA·v² + C_rr·m·g (hand calculation)", () => {
    const inp = resolved();
    const v = 30;
    const byHand = 0.5 * inp.airDensity * inp.dragCoefficient * inp.frontalAreaM2 * v * v + inp.rollingResistance * inp.massKg * G;
    expect(resistance(inp, v)).toBeCloseTo(byHand, 9);
    expect(resistance(inp, 0)).toBeCloseTo(inp.rollingResistance * inp.massKg * G, 9);
  });

  it("the atmosphere model reproduces standard-atmosphere reference values", () => {
    expect(pressureAtElevation(0)).toBe(101325);
    expect(pressureAtElevation(1000)).toBeCloseTo(89875, -2); // ISA: 898.75 hPa at 1 km
    expect(airDensity(25, 0)).toBeCloseTo(1.184, 2); // dry air at 25 °C, sea level
    expect(airDensity(15, 0)).toBeCloseTo(1.225, 2); // ISA sea-level density
    expect(powerCorrectionFactor(25, 0, "na")).toBe(1);
    expect(powerCorrectionFactor(25, 0, "electric")).toBe(1);
    const na2000 = powerCorrectionFactor(25, 2000, "na");
    expect(na2000).toBeCloseTo(pressureAtElevation(2000) / 101325, 6);
    expect(powerCorrectionFactor(25, 2000, "forced")).toBeCloseTo(1 - (1 - na2000) * 0.25, 9);
  });

  it("the test mass is curb mass plus the driver/cargo allowance (80 kg ≈ 176 lb by default)", () => {
    const inp = resolved();
    expect(inp.payloadKg).toBe(80);
    expect(inp.massKg).toBeCloseTo(lbToKg(3549) + 80, 9);
    expect(inp.massKg / KG_PER_LB).toBeCloseTo(3549 + 176.37, 1);
  });
});

describe("run invariants", () => {
  const inp = resolved();
  const run = simulateRun(inp);
  const m = run.metrics;

  it("time, distance and speed traces are monotonic (speed may only fall while a shift interrupts drive)", () => {
    for (let i = 1; i < run.samples.length; i++) {
      const a = run.samples[i - 1];
      const b = run.samples[i];
      expect(b.t).toBeGreaterThan(a.t);
      expect(b.x).toBeGreaterThanOrEqual(a.x);
      if (b.limit !== "shift" && a.limit !== "shift") expect(b.v).toBeGreaterThanOrEqual(a.v - 1e-9);
    }
  });

  it("threshold times are ordered by the speeds they represent and the quarter mile comes after 60 mph", () => {
    expect(m.zeroTo60S).not.toBeNull();
    expect(m.zeroTo100KphS!).toBeGreaterThan(m.zeroTo60S!); // 100 km/h = 62.1 mph
    expect(m.zeroTo100MphS!).toBeGreaterThan(m.zeroTo100KphS!);
    expect(m.quarterMileS!).toBeGreaterThan(m.zeroTo60S!);
    expect(m.fiftyToSeventyS!).toBeGreaterThan(0);
    expect(m.fiftyToSeventyS!).toBeLessThan(m.zeroTo100MphS!);
  });

  it("the quarter-mile trap speed lies inside the sample bracket around the finish time", () => {
    const tq = m.quarterMileS!;
    const before = [...run.samples].reverse().find((s) => s.t <= tq)!;
    const after = run.samples.find((s) => s.t >= tq)!;
    expect(m.quarterMileTrapMs!).toBeGreaterThanOrEqual(Math.min(before.v, after.v) - 1e-6);
    expect(m.quarterMileTrapMs!).toBeLessThanOrEqual(Math.max(before.v, after.v) + 1e-6);
    expect(before.x).toBeLessThanOrEqual(QUARTER_MILE_M + 1e-6);
    expect(after.x).toBeGreaterThanOrEqual(QUARTER_MILE_M - 1e-6);
  });

  it("peak acceleration never exceeds the launch traction bound derived independently from μ, load split and transfer", () => {
    for (const drivetrain of ["RWD", "FWD", "AWD"] as const) {
      const values = c300().values;
      values.drivetrain = { value: drivetrain, provenance: "verified" };
      const r = resolved(values);
      const metrics = simulateRun(r).metrics;
      const bound = launchAccelBound(r) / G; // feasibility module: μ·N_driven / m with load transfer
      expect(metrics.peakAccelG).toBeLessThanOrEqual(bound * 1.02 + 1e-6);
      // Direct check against the engine's own cap at rest, with the 4% rotating-inertia allowance.
      const capAtRest = tractionLimit(r, resistance(r, 0));
      expect(metrics.peakAccelG * G).toBeLessThanOrEqual(capAtRest / (1.04 * r.massKg) + 1e-6);
    }
  });

  it("wheel power never exceeds engine power times drivetrain efficiency, sample by sample", () => {
    const peakWheelKw = Math.max(...run.samples.map((s) => s.wheelPowerKw));
    expect(peakWheelKw).toBeLessThanOrEqual((inp.curve.peakPowerW / 1000) * inp.drivetrainEfficiency * inp.powerFactor * 1.001);
  });
});

describe("extreme and invalid inputs", () => {
  const withValues = (patch: Partial<Record<keyof SpecValues, number | null>>) => {
    const values = c300().values;
    for (const [k, v] of Object.entries(patch)) (values as unknown as Record<string, { value: unknown; provenance: string }>)[k] = { value: v, provenance: "user" };
    return values;
  };
  const errorsFor = (values: SpecValues) => validateValues(values, "stock").filter((i) => i.severity === "error").map((i) => `${i.key}`);

  it("zero or negative power, zero grip, impossible efficiencies and non-finite numbers are rejected by validation", () => {
    expect(errorsFor(withValues({ peakPowerKw: 0 }))).toContain("peakPowerKw");
    expect(errorsFor(withValues({ peakPowerKw: -100 }))).toContain("peakPowerKw");
    expect(errorsFor(withValues({ tireMu: 0 }))).toContain("tireMu");
    expect(errorsFor(withValues({ drivetrainEfficiency: 1.2 }))).toContain("drivetrainEfficiency");
    expect(errorsFor(withValues({ drivetrainEfficiency: 0 }))).toContain("drivetrainEfficiency");
    expect(errorsFor(withValues({ curbMassKg: Number.NaN }))).toContain("curbMassKg");
    expect(errorsFor(withValues({ peakTorqueNm: Number.POSITIVE_INFINITY }))).toContain("peakTorqueNm");
    expect(errorsFor(withValues({ curbMassKg: null }))).toContain("curbMassKg");
  });

  it("gear ratio lists must be positive, bounded and strictly decreasing (duplicates rejected)", () => {
    const dup = c300().values;
    dup.gearRatios = { value: [3.5, 2.1, 2.1, 1.0], provenance: "user" };
    expect(errorsFor(dup)).toContain("gearRatios");
    const tooMany = c300().values;
    tooMany.gearRatios = { value: Array.from({ length: 13 }, (_, i) => 13 - i), provenance: "user" };
    expect(errorsFor(tooMany)).toContain("gearRatios");
    const negative = c300().values;
    negative.gearRatios = { value: [3.5, -1], provenance: "user" };
    expect(errorsFor(negative)).toContain("gearRatios");
  });

  it("invalid environmental conditions are caught at the trust boundary", () => {
    const bad = [
      { ...DEFAULT_CONDITIONS, ambientTempC: -300 },
      { ...DEFAULT_CONDITIONS, elevationM: 50_000 },
      { ...DEFAULT_CONDITIONS, ambientTempC: Number.NaN },
      { ...DEFAULT_CONDITIONS, surface: "lava" as never },
    ];
    for (const c of bad) expect(validateConditions(c).some((i) => i.severity === "error")).toBe(true);
    expect(validateConditions(DEFAULT_CONDITIONS)).toEqual([]);
  });

  it("a hypothetical 5,000 kW / 50 kg configuration stays finite, bounded and clearly outside validated ranges", () => {
    const values = withValues({ peakPowerKw: 5000, peakTorqueNm: 20000, curbMassKg: 50 });
    const issues = validateValues(values, "stock");
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.some((i) => /hypercar/i.test(i.message))).toBe(true);
    const started = Date.now();
    const result = runAnalysis({ stock: { ...c300(), values }, modified: null, conditions: { ...DEFAULT_CONDITIONS } });
    expect(Date.now() - started).toBeLessThan(5000);
    for (const v of Object.values(result.stock.metrics)) if (typeof v !== "string") expect(finiteOrNull(v)).toBe(true);
    expect(result.stock.samples.every((s) => Number.isFinite(s.v) && Number.isFinite(s.x) && Number.isFinite(s.a))).toBe(true);
    expect(result.feasibility.stock.checks.find((c) => c.id === "model.ptw")?.outcome).toBe("caution");
    expect(metricRows(result, "imperial").every((r) => finiteOrNull(r.stock))).toBe(true);
  });

  it("an unreasonably heavy, underpowered vehicle ends without reaching 60 mph instead of looping", () => {
    // 1 kW with 5 N·m: consistent with the fixture's 1,300 rpm torque peak (5 N·m × 136 rad/s = 0.68 kW ≤ 1 kW).
    const values = withValues({ peakPowerKw: 1, peakTorqueNm: 5, curbMassKg: 50000 });
    expect(validateValues(values, "stock").filter((i) => i.severity === "error")).toEqual([]);
    const started = Date.now();
    const result = runAnalysis({ stock: { ...c300(), values }, modified: null, conditions: { ...DEFAULT_CONDITIONS } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.stock.metrics.zeroTo60S).toBeNull();
    expect(result.stock.metrics.quarterMileS).toBeNull();
    for (const v of Object.values(result.stock.metrics)) if (typeof v !== "string") expect(finiteOrNull(v)).toBe(true);
    expect(result.feasibility.stock.checks.find((c) => c.id === "acceleration.envelope")?.detail).toMatch(/does not reach 60 mph/);
    expect(metricRows(result, "imperial").find((r) => r.id === "060")!.stock).toBeNull();
  });

  it("values exactly at the hard bounds simulate to finite results", () => {
    const corners: Partial<Record<keyof SpecValues, number>>[] = [
      { tireMu: 0.1 },
      { tireMu: 3 },
      { drivetrainEfficiency: 0.3 },
      { drivetrainEfficiency: 1 },
      { dragCoefficient: 0.05, frontalAreaM2: 0.3 },
      { dragCoefficient: 2, frontalAreaM2: 15 },
      { cgHeightRatio: 0.05 },
      { cgHeightRatio: 0.6, frontWeightFraction: 0.8 },
      { rollingResistance: 0.2 },
      { shiftTimeS: 3 },
      { finalDrive: 15 },
    ];
    for (const corner of corners) {
      const values = withValues(corner);
      expect(validateValues(values, "stock").filter((i) => i.severity === "error")).toEqual([]);
      const run = simulateRun(resolved(values), { collectSamples: false });
      for (const v of Object.values(run.metrics)) if (typeof v !== "string") expect(finiteOrNull(v)).toBe(true);
    }
  });

  it("a missing vehicle weight is refused by the resolver and by configuration validation", () => {
    const values = c300().values;
    values.curbMassKg = { value: null, provenance: "unavailable" };
    const r = resolveInputs(values, DEFAULT_CONDITIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["curbMassKg"]);
    expect(validateConfig({ stock: { ...c300(), values }, modified: null, conditions: { ...DEFAULT_CONDITIONS } }).errors).toBeGreaterThan(0);
    expect(emptySpecValues().peakPowerKw.value).toBeNull();
  });
});

describe("one rounding policy for displayed differences", () => {
  const row = (stock: number, modified: number, digits: number): MetricRow => ({
    id: "x", label: "x", unit: "s", digits, better: "lower", stock, stockRange: null, modified, modifiedRange: null, kind: "calculated", stockSource: "calculated", modifiedSource: "calculated", stockBasis: null, modifiedBasis: null,
  });

  it("differences are taken between the rounded figures a reader sees", () => {
    const d = rowDelta(row(6.1949, 5.0451, 2))!; // displayed 6.19 → 5.05
    expect(d.abs).toBeCloseTo(-1.14, 10); // not −1.15 from the unrounded internals
    expect(d.rel).toBeCloseTo((-1.14 / 6.19) * 100, 6);
    expect(d.improved).toBe(true);
    const mass = rowDelta(row(3769.6, 3593.7, 0))!;
    expect(mass.abs).toBe(-176);
    expect(rowDelta(row(6.1941, 6.1943, 2))!.abs).toBe(0); // both display as 6.19
    expect(rowDelta(row(6.1941, 6.1943, 2))!.improved).toBeNull();
  });

  it("the same policy reaches the comparison table of a real run", () => {
    const cfg = config();
    cfg.modified = { overrides: { peakPowerKw: { value: hpToKw(301), provenance: "user" } } };
    const rows = metricRows(runAnalysis(cfg), "imperial");
    for (const r of rows) {
      const d = rowDelta(r);
      if (!d) continue;
      const shown = Number((r.modified! ).toFixed(r.digits)) - Number(r.stock!.toFixed(r.digits));
      expect(d.abs).toBeCloseTo(shown, 9);
    }
  });
});
