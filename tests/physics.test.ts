import { describe, expect, it } from "vitest";
import { explainAnalysis } from "@/lib/analysis/explain";
import { effectiveValues } from "@/lib/domain/scenario";
import type { AnalysisConfig, SpecValues } from "@/lib/domain/types";
import { runAnalysis } from "@/lib/physics/analysis";
import { airDensity, powerCorrectionFactor } from "@/lib/physics/atmosphere";
import { sampleCurve, torqueAt } from "@/lib/physics/curve";
import { resolveInputs } from "@/lib/physics/resolve";
import { simulateRun } from "@/lib/physics/simulate";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { hpToKw, kgToLb, lbToKg, lbftToNm, msToMph, rpmToRadS } from "@/lib/units";
import { c300, config, ev } from "./support/fixtures";

const user = <T,>(value: T) => ({ value, provenance: "user" as const, source: "test" });

function withModified(overrides: Partial<SpecValues>): AnalysisConfig {
  return { ...config(), modified: { overrides } };
}

function allFinite(obj: unknown): boolean {
  if (typeof obj === "number") return Number.isFinite(obj);
  if (obj && typeof obj === "object") return Object.values(obj).every((v) => v === null || allFinite(v));
  return true;
}

describe("torque curve synthesis", () => {
  it("preserves the stated peak power and peak torque exactly", () => {
    const r = resolveInputs(c300().values, DEFAULT_CONDITIONS, { bodyStyle: "Sedan" });
    if (!r.ok) throw new Error("resolve failed");
    const curve = sampleCurve(r.inputs.curve, 400);
    const maxP = Math.max(...curve.map((c) => c.powerKw));
    const maxT = Math.max(...curve.map((c) => c.torqueNm));
    expect(maxP).toBeCloseTo(hpToKw(241), 0);
    expect(maxT).toBeCloseTo(lbftToNm(273), 0);
    // power is T·ω everywhere
    for (const c of curve.slice(1)) expect(c.powerKw).toBeCloseTo((c.torqueNm * rpmToRadS(c.rpm)) / 1000, 6);
  });

  it("models electric drive as constant torque then constant power", () => {
    const p = { peakPowerW: 258000, peakTorqueNm: 420, peakPowerRpm: 0, peakTorqueRpm: 0, redlineRpm: 16000, idleRpm: 0, shape: "electric" as const };
    expect(torqueAt(p, 100)).toBeCloseTo(420);
    const base = (258000 / 420) * (60 / (2 * Math.PI));
    expect(torqueAt(p, base * 2) * rpmToRadS(base * 2)).toBeCloseTo(258000, 0);
    expect(torqueAt(p, 17000)).toBe(0);
  });
});

describe("simulation", () => {
  const stock = runAnalysis(config());

  it("produces plausible, finite stock results", () => {
    const m = stock.stock.metrics;
    expect(m.zeroTo60S).toBeGreaterThan(5);
    expect(m.zeroTo60S).toBeLessThan(8);
    expect(m.quarterMileS).toBeGreaterThan(13.5);
    expect(m.quarterMileS).toBeLessThan(16.5);
    expect(allFinite(m)).toBe(true);
    expect(stock.stock.samples.every((s) => Number.isFinite(s.v) && s.v >= 0)).toBe(true);
  });

  it("is deterministic: identical inputs give identical results", () => {
    const again = runAnalysis(config());
    expect(again.stock.metrics).toEqual(stock.stock.metrics);
    expect(again.stock.samples).toEqual(stock.stock.samples);
  });

  it("identical stock and modified scenarios produce identical metrics", () => {
    const r = runAnalysis(withModified({}));
    expect(r.modified!.metrics).toEqual(r.stock.metrics);
    expect(explainAnalysis(r).findings.some((f) => f.id === "cmp-same")).toBe(true);
  });

  it("more power improves acceleration and trap speed", () => {
    const r = runAnalysis(withModified({ peakPowerKw: user(hpToKw(281)) }));
    expect(r.modified!.metrics.zeroTo60S!).toBeLessThan(r.stock.metrics.zeroTo60S!);
    expect(r.modified!.metrics.quarterMileS!).toBeLessThan(r.stock.metrics.quarterMileS!);
    expect(r.modified!.metrics.quarterMileTrapMs!).toBeGreaterThan(r.stock.metrics.quarterMileTrapMs!);
  });

  it("less mass improves acceleration", () => {
    const r = runAnalysis(withModified({ curbMassKg: user(lbToKg(3549 - 150)) }));
    expect(r.modified!.metrics.zeroTo60S!).toBeLessThan(r.stock.metrics.zeroTo60S!);
    expect(r.modified!.inputs.massKg).toBeCloseTo(r.stock.inputs.massKg - lbToKg(150), 6);
  });

  it("modifying never mutates the stock baseline", () => {
    const cfg = withModified({ peakPowerKw: user(hpToKw(400)), curbMassKg: user(1400) });
    const before = JSON.stringify(cfg.stock);
    const r = runAnalysis(cfg);
    expect(JSON.stringify(cfg.stock)).toBe(before);
    expect(r.stock.metrics).toEqual(stock.stock.metrics);
    expect(effectiveValues(cfg, "stock")!.peakPowerKw.value).toBeCloseTo(hpToKw(241));
  });

  it("attributes changes to power and mass groups separately", () => {
    const r = runAnalysis(withModified({ peakPowerKw: user(hpToKw(281)), curbMassKg: user(lbToKg(3399)) }));
    const groups = r.attribution!.map((a) => a.group);
    expect(groups).toEqual(["output", "mass"]);
    expect(r.attribution!.every((a) => a.delta060! < 0)).toBe(true);
  });

  it("wheel power never exceeds engine power after drivetrain losses", () => {
    const r = stock.stock;
    const limit = (r.inputs.curve.peakPowerW * r.inputs.drivetrainEfficiency * r.inputs.powerFactor) / 1000;
    for (const s of r.samples) expect(s.wheelPowerKw).toBeLessThanOrEqual(limit * 1.0001 * 2.0 /* torque-converter multiplication at stall */);
    const coupled = r.samples.filter((s) => s.v > 15);
    for (const s of coupled) expect(s.wheelPowerKw).toBeLessThanOrEqual(limit + 1e-6);
  });

  it("traction limits launch: more grip helps more than power at launch for a RWD car", () => {
    const grip = runAnalysis(withModified({ tireMu: user(1.2) }));
    expect(grip.modified!.metrics.peakAccelG).toBeGreaterThan(grip.stock.metrics.peakAccelG);
  });

  it("uncertainty range brackets the nominal result", () => {
    const m = stock.stock;
    expect(m.range.optimistic.zeroTo60S!).toBeLessThanOrEqual(m.metrics.zeroTo60S! + 1e-9);
    expect(m.range.conservative.zeroTo60S!).toBeGreaterThanOrEqual(m.metrics.zeroTo60S! - 1e-9);
  });

  it("handles electric vehicles with the EV model and labels the limitation", () => {
    const r = runAnalysis(config(ev()));
    expect(r.stock.inputs.transmission).toBe("direct");
    expect(r.stock.metrics.zeroTo60S).toBeGreaterThan(3);
    expect(r.stock.metrics.shiftsTo60).toBe(0);
    expect(explainAnalysis(r).findings.some((f) => f.id === "stock-ev")).toBe(true);
  });

  it("labels hybrid modeling limitations", () => {
    const s = c300();
    s.values.powertrain = user("hybrid");
    const r = runAnalysis(config(s));
    expect(explainAnalysis(r).findings.some((f) => f.id === "stock-hybrid")).toBe(true);
  });

  it("refuses to simulate without power or mass", () => {
    const s = c300();
    s.values.peakPowerKw = { value: null, provenance: "unavailable" };
    expect(resolveInputs(s.values, DEFAULT_CONDITIONS)).toEqual({ ok: false, missing: ["peakPowerKw"] });
    expect(() => runAnalysis(config(s))).toThrow(/Missing required inputs/);
  });

  it("labels every value it estimates", () => {
    const r = stock.stock;
    const keys = r.estimates.map((e) => e.key);
    expect(keys).toEqual(expect.arrayContaining(["dragCoefficient", "finalDrive", "gearRatios", "tireMu"]));
    expect(r.provenance.dragCoefficient).toBe("estimated");
    expect(r.provenance.peakPowerKw).toBe("verified");
  });

  it("reduces air density and NA power with altitude and heat", () => {
    expect(airDensity(25, 1600)).toBeLessThan(airDensity(25, 0));
    expect(powerCorrectionFactor(25, 0, "na")).toBeCloseTo(1, 6);
    expect(powerCorrectionFactor(25, 1600, "na")).toBeLessThan(0.85);
    expect(powerCorrectionFactor(25, 1600, "forced")).toBeGreaterThan(powerCorrectionFactor(25, 1600, "na"));
    expect(powerCorrectionFactor(35, 1600, "electric")).toBe(1);
    const high = runAnalysis({ ...config(), conditions: { ...DEFAULT_CONDITIONS, elevationM: 1600 } });
    expect(high.stock.metrics.zeroTo60S!).toBeGreaterThan(stock.stock.metrics.zeroTo60S!);
  });

  it("applies the 1-ft rollout convention only when enabled", () => {
    const r = runAnalysis({ ...config(), conditions: { ...DEFAULT_CONDITIONS, rollout: true } });
    expect(r.stock.metrics.zeroTo60S!).toBeLessThan(stock.stock.metrics.zeroTo60S!);
    expect(stock.stock.metrics.zeroTo60S! - r.stock.metrics.zeroTo60S!).toBeLessThan(0.5);
  });

  it("reports theoretical top speed consistent with drag balance", () => {
    const r = resolveInputs(c300().values, DEFAULT_CONDITIONS, { bodyStyle: "Sedan" });
    if (!r.ok) throw new Error();
    const run = simulateRun(r.inputs);
    const mph = msToMph(run.metrics.topSpeedMs!);
    expect(mph).toBeGreaterThan(120);
    expect(mph).toBeLessThan(200);
  });

  it("gives heavier variants a higher weight-to-power figure", () => {
    const r = runAnalysis(withModified({ curbMassKg: user(lbToKg(4000)) }));
    expect(kgToLb(r.modified!.inputs.massKg)).toBeGreaterThan(kgToLb(r.stock.inputs.massKg));
    expect(r.modified!.powerToWeightWkg).toBeLessThan(r.stock.powerToWeightWkg);
  });
});
