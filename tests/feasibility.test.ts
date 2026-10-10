import { describe, expect, it } from "vitest";
import { applyProposal } from "@/lib/ai/apply";
import type { Proposal } from "@/lib/ai/types";
import { MODEL_SOURCE, relatedValues } from "@/lib/domain/powerTorque";
import { effectiveValues, setModifiedValue } from "@/lib/domain/scenario";
import { DEFAULT_CONDITIONS, type AnalysisConfig, type SpecSet, type SpecValues } from "@/lib/domain/types";
import { assessConfig } from "@/lib/feasibility/assess";
import { launchAccelBound, maxSpeedByPower, minZeroTo60 } from "@/lib/feasibility/bounds";
import type { FeasibilityAssessment } from "@/lib/feasibility/types";
import { runAnalysis } from "@/lib/physics/analysis";
import { resolveInputs } from "@/lib/physics/resolve";
import { fromDisplay, G, hpToKw, kphToMs, lbftToNm, lbToKg, mphToMs } from "@/lib/units";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";
import { customSpecSet } from "@/lib/vehicles/normalize";
import { initialState, reducer } from "@/state/reducer";

const user = (value: number) => ({ value, provenance: "user" as const });
const c300 = () => datasetSpecSet(allDatasetTrims().find((t) => t.year === 2015 && t.model === "C300" && t.drive === "rear wheel drive" && /^C 300 4dr/.test(t.description ?? ""))!);
const cfg = (patch: Partial<AnalysisConfig> = {}, stock: SpecSet = c300()): AnalysisConfig => ({ stock, modified: null, conditions: { ...DEFAULT_CONDITIONS }, ...patch });
const withMod = (overrides: Partial<SpecValues>, patch: Partial<AnalysisConfig> = {}) => cfg({ modified: { overrides }, ...patch });
const feas = (c: AnalysisConfig) => runAnalysis(c).feasibility;
const check = (a: FeasibilityAssessment, id: string) => a.checks.find((c) => c.id === id);
const finite = (o: unknown): boolean => (typeof o === "number" ? Number.isFinite(o) : o && typeof o === "object" ? Object.values(o).every((v) => v === null || finite(v)) : true);

describe("feasibility engine", () => {
  it("1. ordinary vehicle with adequate data is feasible, and mechanical limits are reported as not assessed", () => {
    const a = feas(cfg()).stock;
    expect(a.status).toBe("feasible");
    expect(a.headline).toBe("Feasible within modeled constraints");
    expect(a.checks.every((c) => c.outcome !== "violation" && c.outcome !== "caution")).toBe(true);
    expect(check(a, "mechanical.driveline")!.outcome).toBe("not_assessed");
    expect(check(a, "acceleration.envelope")!.outcome).toBe("pass");
    expect(a.primaryReason).toMatch(/not a certification/);
  });

  it("2. missing core data gives Insufficient data — never Non-feasible", () => {
    const custom = customSpecSet("Project car", null);
    custom.values.peakPowerKw = user(hpToKw(300));
    const r = assessConfig(cfg({}, custom));
    expect(r.stock).toMatchObject({ status: "insufficient_data", headline: "Insufficient data to assess" });
    expect((r.stock as FeasibilityAssessment).missing.join(" ")).toMatch(/Vehicle weight/);

    // Power and weight known, but torque, drivetrain and transmission all assumed.
    custom.values.curbMassKg = user(1500);
    expect(feas(cfg({}, custom)).stock.status).toBe("insufficient_data");
  });

  it("3. extremely high but valid horsepower is simulated and Questionable, not rejected", () => {
    const c = withMod({ peakPowerKw: user(hpToKw(1900)), peakTorqueNm: user(lbftToNm(2000)) });
    const r = runAnalysis(c);
    expect(r.feasibility.modified!.status).toBe("questionable");
    expect(check(r.feasibility.modified!, "model.ptw")!.outcome).toBe("caution");
    expect(check(r.feasibility.modified!, "mechanical.driveline")!.outcome).toBe("caution");
    expect(r.feasibility.modified!.checks.some((x) => x.outcome === "violation")).toBe(false);
    expect(finite(r.modified!.metrics)).toBe(true);
    expect(r.modified!.metrics.zeroTo60S!).toBeLessThan(r.stock.metrics.zeroTo60S!);
  });

  it("4. high power on the same tires is traction-limited and flagged with the force ratio", () => {
    const a = feas(withMod({ peakPowerKw: user(hpToKw(500)), peakTorqueNm: user(lbftToNm(560)) })).modified!;
    const t = check(a, "traction.launch")!;
    expect(t.outcome).toBe("caution");
    expect(t.detail).toMatch(/× the force the tires can transmit/);
    expect(a.status).toBe("questionable");
  });

  it("5. significant weight reduction requires verification and still changes the physics", () => {
    const c = withMod({ curbMassKg: user(lbToKg(2400)) });
    const r = runAnalysis(c);
    const m = check(r.feasibility.modified!, "mass.change")!;
    expect(m.outcome).toBe("caution");
    expect(m.detail).toMatch(/−29\.8%/);
    expect(r.modified!.metrics.zeroTo60S!).toBeLessThan(r.stock.metrics.zeroTo60S!);
  });

  it("6. traction-dominated result with an estimated tire grip is questioned; a stated grip is accepted", () => {
    const c = withMod({ peakPowerKw: user(hpToKw(340)), peakTorqueNm: user(lbftToNm(390)) });
    const est = feas(c).modified!;
    expect(check(est, "traction.launch")!.outcome).toBe("caution");
    expect(est.missing.join(" ")).toMatch(/Tire grip/);
    const stated = feas(withMod({ tireMu: user(1.0) })).modified!;
    expect(stated.missing.join(" ")).not.toMatch(/Tire grip/);
  });

  it("7–8. invalid mass and efficiency are input errors, not feasibility outcomes", () => {
    const badMass = c300();
    badMass.values.curbMassKg = user(-1200);
    expect(assessConfig(cfg({}, badMass)).stock).toMatchObject({ status: "input_error" });
    const badEff = c300();
    badEff.values.drivetrainEfficiency = user(1.4);
    const r = assessConfig(cfg({}, badEff)).stock!;
    expect(r.status).toBe("input_error");
    if (r.status === "input_error") expect(r.issues[0].key).toBe("drivetrainEfficiency");
  });

  it("9. power and torque that contradict each other at the stated rpm are input errors", () => {
    const s = c300();
    s.values.peakPowerKw = user(hpToKw(500)); // needs ≈ 473 lb·ft at the verified 5,550 rpm power peak
    const r = assessConfig(cfg({}, s)).stock!;
    expect(r.status).toBe("input_error");
    if (r.status === "input_error") expect(r.issues.some((i) => i.key === "peakTorqueNm")).toBe(true);
  });

  it("10. claims that violate demonstrated physical bounds are Non-feasible with the violated constraint named", () => {
    const zero = feas(cfg({ constraints: { stock: { claimedZeroTo60S: 2.0 } } })).stock;
    expect(zero.status).toBe("non_feasible");
    expect(zero.headline).toBe("Conflicts with modeled constraints");
    const v = check(zero, "claims.zeroTo60")!;
    expect(v.outcome).toBe("violation");
    expect(v.detail).toMatch(/needs an average 1\.37 g/);
    expect(zero.primaryReason).toBe(v.detail);

    const top = feas(cfg({ constraints: { stock: { claimedTopSpeedMs: mphToMs(300) } } })).stock;
    expect(check(top, "claims.topSpeed")!.outcome).toBe("violation");

    const torque = feas(withMod({ peakTorqueNm: user(lbftToNm(400)) }, { constraints: { stock: { drivetrainTorqueLimitNm: lbftToNm(350) } } }));
    expect(torque.stock.status).toBe("feasible"); // 273 lb·ft within the 350 lb·ft rating
    expect(check(torque.modified!, "mechanical.driveline")!.outcome).toBe("violation");

    // A plausible claim is consistent.
    expect(check(feas(cfg({ constraints: { stock: { claimedZeroTo60S: 6.5 } } })).stock, "claims.zeroTo60")!.outcome).toBe("pass");
  });

  it("11. Stock can be Feasible while Modified is Questionable", () => {
    const f = feas(withMod({ peakPowerKw: user(hpToKw(281)) }));
    expect(f.stock.status).toBe("feasible");
    expect(f.modified!.status).toBe("questionable");
    expect(f.modified!.primaryReason).toMatch(/no component ratings/);
  });

  it("12. identical inputs give identical assessments", () => {
    const c = withMod({ peakPowerKw: user(hpToKw(330)), curbMassKg: user(lbToKg(3300)) }, { constraints: { modified: { claimedZeroTo60S: 4.0 } } });
    expect(feas(c)).toEqual(feas(structuredClone(c)));
  });

  it("13. unit system used for entry does not change the classification", () => {
    const imperial = cfg({ constraints: { stock: { claimedTopSpeedMs: fromDisplay("speed", 186, "imperial") } } });
    const metric = cfg({ constraints: { stock: { claimedTopSpeedMs: fromDisplay("speed", 186 * 1.609344, "metric") } } });
    const a = feas(imperial).stock;
    const b = feas(metric).stock;
    expect(a.status).toBe(b.status);
    expect(a.checks.map((c) => c.outcome)).toEqual(b.checks.map((c) => c.outcome));
    expect(kphToMs(186 * 1.609344)).toBeCloseTo(mphToMs(186), 9);
  });

  it("14. switching vehicles clears vehicle-specific claims and component ratings", () => {
    let s = reducer(initialState, { type: "loadVehicle", specSet: c300() });
    s = reducer(s, { type: "setConstraint", scenario: "stock", key: "drivetrainTorqueLimitNm", value: 400 });
    s = reducer(s, { type: "setConstraint", scenario: "stock", key: "claimedZeroTo60S", value: 3 });
    expect(s.config.constraints?.stock?.claimedZeroTo60S).toBe(3);
    s = reducer(s, { type: "loadVehicle", specSet: c300() });
    expect(s.config.constraints).toEqual({});
  });

  it("15. Manual Setup and AI Build Assistant produce identical assessments for identical inputs", () => {
    const base = cfg();
    const stockKw = base.stock!.values.peakPowerKw.value!;
    const manual = setModifiedValue({ ...base, modified: { overrides: {} } }, "peakPowerKw", { value: stockKw + hpToKw(40), delta: hpToKw(40), provenance: "user", source: "User-provided assumption" });
    const proposal: Proposal = {
      id: "p",
      intent: "modify",
      vehicle: null,
      changes: [{ id: "c0", target: "modified", key: "peakPowerKw", op: "add", value: hpToKw(40), display: "+40 hp", reason: "", statedByUser: true }],
      rejected: [],
      view: "compare",
      runAfterApply: true,
    };
    const ai = applyProposal(base, proposal, { selected: { c0: true } }).config;
    // Manual Setup reaches the identical scenario through "Adjust related values" (the same model).
    const related = relatedValues(manual.stock!.values, effectiveValues(manual, "modified")!, manual.stock!.identity)!;
    for (const d of related.derived) manual.modified!.overrides[d.key] = { value: d.to, provenance: "estimated", source: MODEL_SOURCE, note: d.reason };
    expect(effectiveValues(ai, "modified")!.peakTorqueNm).toEqual(effectiveValues(manual, "modified")!.peakTorqueNm);
    const a = runAnalysis(manual);
    const b = runAnalysis(ai);
    expect(b.modified!.metrics).toEqual(a.modified!.metrics);
    expect(b.feasibility).toEqual(a.feasibility);
  });

  it("16. mechanical limits without component data are uncertainty, never fabricated conclusions", () => {
    const f = feas(withMod({ peakPowerKw: user(hpToKw(300)), peakTorqueNm: user(lbftToNm(320)) }));
    const m = check(f.modified!, "mechanical.driveline")!;
    expect(m.outcome).toBe("caution");
    expect(m.detail).toMatch(/no component ratings available/);
    expect(f.modified!.checks.some((c) => c.outcome === "violation")).toBe(false);
    expect(f.modified!.missing.join(" ")).toMatch(/Drivetrain torque rating/);
  });
});

describe("physical bounds", () => {
  it("traction bound matches the closed-form RWD limit and never exceeds μ·g", () => {
    const r = resolveInputs(c300().values, DEFAULT_CONDITIONS, { bodyStyle: "Sedan" });
    if (!r.ok) throw new Error();
    const a = launchAccelBound(r.inputs);
    expect(a / G).toBeLessThan(r.inputs.tireMu);
    expect(a / G).toBeGreaterThan(0.45);
    expect(minZeroTo60(r.inputs, false)).toBeCloseTo(mphToMs(60) / a, 9);
    const simulated = runAnalysis(cfg()).stock.metrics.zeroTo60S!;
    expect(simulated).toBeGreaterThan(minZeroTo60(r.inputs, false));
    expect(runAnalysis(cfg()).stock.metrics.topSpeedMs!).toBeLessThanOrEqual(maxSpeedByPower(r.inputs) + 0.2);
  });
});

describe("extreme configurations stay finite and honest", () => {
  it("absurdly strong, light, grippy, slippery builds simulate without NaN or crashes", () => {
    const r = runAnalysis(withMod({ peakPowerKw: user(4000), peakTorqueNm: user(6000), curbMassKg: user(400), tireMu: user(2.5), dragCoefficient: user(0.06) }));
    expect(finite(r.modified!.metrics)).toBe(true);
    expect(r.modified!.samples.every((s) => Number.isFinite(s.v) && s.v >= 0 && Number.isFinite(s.a))).toBe(true);
    expect(r.feasibility.modified!.status).toBe("questionable");
    expect(r.feasibility.modified!.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["traction.grip", "aero.cda", "model.ptw"]));
  });

  it("an underpowered build that cannot reach 60 mph reports that instead of inventing a time", () => {
    const s = customSpecSet("Tractor", null);
    s.values.peakPowerKw = user(8);
    s.values.peakTorqueNm = user(60);
    s.values.curbMassKg = user(3000);
    s.values.drivetrain = { value: "RWD", provenance: "user" };
    s.values.transmission = { value: "manual", provenance: "user" };
    const r = runAnalysis(cfg({}, s));
    expect(r.stock.metrics.zeroTo60S).toBeNull();
    expect(check(r.feasibility.stock, "acceleration.envelope")!.detail).toMatch(/does not reach 60 mph/);
  });
});
