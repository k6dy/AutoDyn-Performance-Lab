// Regression tests from the engineering audit of an extreme hypothetical build (2019 AMG GT 63 S at
// 3,000 hp / 3,000 lb·ft / 4,000 lb). Assertions are physical relationships, not hard-coded outputs.
import { describe, expect, it } from "vitest";
import { explainAnalysis } from "@/lib/analysis/explain";
import { userValue } from "@/lib/domain/scenario";
import { DEFAULT_CONDITIONS, type AnalysisConfig } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { runAnalysis } from "@/lib/physics/analysis";
import { resolveInputs } from "@/lib/physics/resolve";
import { simulateRun } from "@/lib/physics/simulate";
import { hpToKw, lbftToNm, lbToKg } from "@/lib/units";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";
import { c300, config } from "./support/fixtures";

function amg(): AnalysisConfig {
  const t = allDatasetTrims().find((x) => x.year === 2019 && x.model === "AMG GT 63 S")!;
  return { stock: datasetSpecSet(t), modified: null, conditions: { ...DEFAULT_CONDITIONS } };
}

function extreme(): AnalysisConfig {
  return {
    ...amg(),
    modified: { overrides: { peakPowerKw: userValue(hpToKw(3000)), peakTorqueNm: userValue(lbftToNm(3000)), curbMassKg: userValue(lbToKg(4000)) } },
  };
}

const finite = (x: unknown): boolean =>
  typeof x === "number" ? Number.isFinite(x) : Array.isArray(x) ? x.every(finite) : x && typeof x === "object" ? Object.values(x).every(finite) : true;

describe("extreme hypothetical build (AMG GT 63 S, 3,000 hp)", () => {
  const r = runAnalysis(extreme());
  const s = r.stock;
  const m = r.modified!;

  it("is a valid (if extreme) input and stays numerically stable", () => {
    expect(validateConfig(extreme()).errors).toBe(0);
    expect(finite(m.metrics)).toBe(true);
    expect(finite(m.samples.map((x) => [x.t, x.v, x.a, x.x, x.rpm]))).toBe(true);
    expect(finite(m.curve)).toBe(true);
    expect(m.metrics.zeroTo60S!).toBeGreaterThan(2);
  });

  it("stock results are independent of the modified scenario", () => {
    const stockOnly = runAnalysis(amg());
    expect(s.metrics).toEqual(stockOnly.stock.metrics);
    expect(s.sensitivity).toEqual(stockOnly.stock.sensitivity);
  });

  it("is traction-limited: acceleration is capped near μ·g regardless of power", () => {
    expect(m.metrics.tractionShareTo60!).toBeGreaterThan(0.85);
    const mu = m.inputs.tireMu * m.inputs.surfaceFactor;
    expect(m.metrics.peakAccelG).toBeLessThanOrEqual(mu + 1e-9);
    // Same traction ceiling as stock, so the 0–60 gain is small even with ~4.8× the power…
    expect(m.metrics.peakAccelG).toBeCloseTo(s.metrics.peakAccelG, 2);
    expect(m.metrics.zeroTo60S!).toBeLessThan(s.metrics.zeroTo60S!);
    // …while the power-limited part of the run (quarter mile, trap speed) improves a lot.
    expect(s.metrics.quarterMileS! - m.metrics.quarterMileS!).toBeGreaterThan(1.5);
    expect(m.metrics.quarterMileTrapMs!).toBeGreaterThan(s.metrics.quarterMileTrapMs! * 1.3);
  });

  it("flat sensitivities are physically justified and explained, not missing", () => {
    const by = (id: string) => m.sensitivity.find((x) => x.id === id)!;
    for (const id of ["output", "efficiency"]) {
      expect(Math.abs(by(id).favorable060!)).toBeLessThan(0.005);
      expect(by(id).note).toMatch(/traction-limited/);
    }
    // Grip is what matters here, in both directions.
    expect(by("grip").favorable060!).toBeLessThan(-0.1);
    expect(by("grip").unfavorable060!).toBeGreaterThan(0.1);
    // Mass nearly cancels under traction limitation (grip scales with weight).
    expect(Math.abs(by("mass").favorable060!)).toBeLessThan(0.01);
    expect(by("mass").note).toMatch(/grip scales with vehicle weight/);
    const sweep = m.massSweep.map((p) => p.zeroTo60S!);
    expect(Math.max(...sweep) - Math.min(...sweep)).toBeLessThan(0.02);
    expect(explainAnalysis(r).findings.some((f) => /more power would not change 0–60/.test(f.title))).toBe(true);
  });

  it("every sensitivity row names both directions", () => {
    for (const x of [...s.sensitivity, ...m.sensitivity]) {
      expect(x.favorableLabel).toBeTruthy();
      expect(x.unfavorableLabel).toBeTruthy();
    }
    const gearing = s.sensitivity.find((x) => x.id === "gearing")!;
    if (gearing.favorable060! > 0.005) expect(gearing.note).toMatch(/upshift|slower/);
  });

  it("is classified Questionable on documented constraints — not impossible just for having 3,000 hp", () => {
    expect(r.feasibility.modified!.status).toBe("questionable");
    // Missing component ratings are reported as unverified — never a fabricated rating or violation.
    const driveline = r.feasibility.modified!.checks.find((c) => c.id === "mechanical.driveline")!;
    expect(driveline.outcome).toBe("caution");
    expect(driveline.detail).toMatch(/no component ratings available/);
    expect(r.feasibility.modified!.checks.some((c) => c.outcome === "violation")).toBe(false);
  });

  it("is deterministic", () => {
    const again = runAnalysis(extreme(), new Date(r.createdAt));
    expect(again).toEqual(r);
  });
});

describe("integration accuracy", () => {
  it("threshold times are interpolated: power-limited mass sweep is strictly monotonic (no dt steps)", () => {
    const r = runAnalysis(config(c300()));
    const t = r.stock.massSweep.map((p) => p.zeroTo60S!);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });

  it("results converge with the time step", () => {
    const res = resolveInputs(c300().values, DEFAULT_CONDITIONS);
    if (!res.ok) throw new Error("unresolved");
    const coarse = simulateRun(res.inputs, { dt: 0.008, topSpeed: false }).metrics;
    const fine = simulateRun(res.inputs, { dt: 0.001, topSpeed: false }).metrics;
    expect(Math.abs(coarse.zeroTo60S! - fine.zeroTo60S!)).toBeLessThan(0.02);
    expect(Math.abs(coarse.quarterMileS! - fine.quarterMileS!)).toBeLessThan(0.03);
  });

  it("sensitivities move in the expected direction for a power-limited car", () => {
    const r = runAnalysis(config(c300()));
    const by = (id: string) => r.stock.sensitivity.find((x) => x.id === id)!;
    expect(by("output").favorable060!).toBeLessThan(-0.05);
    expect(by("output").unfavorable060!).toBeGreaterThan(0.05);
    expect(by("mass").favorable060!).toBeLessThan(-0.05);
    expect(by("output").note).toBeNull();
  });
});
