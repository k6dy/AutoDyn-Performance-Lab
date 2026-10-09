import { describe, expect, it } from "vitest";
import { GET as specRoute } from "@/app/api/vehicles/spec/route";
import { effectiveValues, setModifiedValue } from "@/lib/domain/scenario";
import { sanitizeRestored } from "@/lib/domain/sanitize";
import { DEFAULT_CONDITIONS, type AnalysisConfig } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { runAnalysis } from "@/lib/physics/analysis";
import { resolveInputs } from "@/lib/physics/resolve";
import { kgToLb, lbToKg } from "@/lib/units";
import { allDatasetTrims, datasetSpecSet, datasetTrim } from "@/lib/vehicles/dataset.server";
import { customSpecSet } from "@/lib/vehicles/normalize";
import { classifyVehicle, estimateForClass, estimateWeightFromDataset } from "@/lib/vehicles/weight";

const TLX_NO_WEIGHT = "6333"; // 2020 Acura TLX SH-AWD PMC Edition — siblings have published weights
const IMPALA_NO_WEIGHT = "6724"; // 2020 Chevrolet Impala LT — no 2020 Impala trim has a weight
const C300 = () => allDatasetTrims().find((t) => t.year === 2015 && t.model === "C300" && t.drive === "rear wheel drive" && /^C 300 4dr/.test(t.description ?? ""))!;

const cfg = (stock = datasetSpecSet(C300())): AnalysisConfig => ({ stock, modified: null, conditions: { ...DEFAULT_CONDITIONS } });

describe("curb weight sourcing", () => {
  it("uses the published weight when the source has one (verified, no estimate offered)", () => {
    const s = datasetSpecSet(C300());
    expect(s.values.curbMassKg).toMatchObject({ provenance: "verified" });
    expect(kgToLb(s.values.curbMassKg.value!)).toBeCloseTo(3417, 6);
    expect(s.identity.weightEstimate).toBeUndefined();
  });

  it("offers — but never applies — an estimate when the trim has no published weight", () => {
    const s = datasetSpecSet(datasetTrim(TLX_NO_WEIGHT)!);
    expect(s.values.curbMassKg).toMatchObject({ value: null, provenance: "unavailable" });
    const e = s.identity.weightEstimate!;
    expect(e.method).toBe("same-model");
    expect(e.basis).toMatch(/2020 Acura TLX/);
    const siblings = allDatasetTrims().filter((t) => t.year === 2020 && t.model === "TLX" && t.curbWeightLb != null).map((t) => t.curbWeightLb!);
    expect(kgToLb(e.kg)).toBeGreaterThanOrEqual(Math.min(...siblings));
    expect(kgToLb(e.kg)).toBeLessThanOrEqual(Math.max(...siblings));
    // The simulation still refuses to run until the user accepts or enters a weight.
    expect(resolveInputs(s.values, DEFAULT_CONDITIONS)).toEqual({ ok: false, missing: ["curbMassKg"] });
    const issue = validateConfig(cfg(s)).issues.find((i) => i.key === "curbMassKg")!;
    expect(issue).toMatchObject({ severity: "error" });
    expect(issue.message).toMatch(/Vehicle weight is needed/);
  });

  it("falls back to nearby model years, then to a documented vehicle class", () => {
    const impala = datasetTrim(IMPALA_NO_WEIGHT)!;
    const e = estimateWeightFromDataset(impala, allDatasetTrims())!;
    expect(["model-years", "class"]).toContain(e.method);
    const lonely = { ...impala, make: "Nobody", model: "Prototype" };
    const c = estimateWeightFromDataset(lonely, allDatasetTrims())!;
    expect(c.method).toBe("class");
    expect(c.classId).toBe(classifyVehicle(impala.body, impala.lengthIn));
  });

  it("class estimates are ordered and plausible", () => {
    const lb = (id: Parameters<typeof estimateForClass>[0]) => kgToLb(estimateForClass(id).kg);
    expect(lb("car-small")).toBeLessThan(lb("car-mid"));
    expect(lb("car-mid")).toBeLessThan(lb("car-large"));
    expect(lb("suv-small")).toBeLessThan(lb("suv-large"));
    expect(lb("pickup")).toBeGreaterThan(4500);
    for (const id of ["car-small", "car-mid", "car-large", "suv-small", "suv-mid", "suv-large", "pickup", "van"] as const) {
      const e = estimateForClass(id);
      expect(e.lowKg).toBeLessThanOrEqual(e.kg);
      expect(e.highKg).toBeGreaterThanOrEqual(e.kg);
    }
  });

  it("an accepted estimate runs through the same engine and stays labeled as an estimate", () => {
    const s = datasetSpecSet(datasetTrim(TLX_NO_WEIGHT)!);
    s.values.curbMassKg = { value: s.identity.weightEstimate!.kg, provenance: "estimated", source: "AutoDyn estimate", note: s.identity.weightEstimate!.basis };
    const r = runAnalysis(cfg(s));
    expect(r.stock.provenance.curbMassKg).toBe("estimated");
    expect(r.stock.inputs.curbMassKg).toBeCloseTo(s.identity.weightEstimate!.kg, 9);
    expect(r.stock.metrics.zeroTo60S).toBeGreaterThan(3);
  });

  it("the spec API attaches the estimate for trims without a weight", async () => {
    const body = await (await specRoute(new Request(`http://t/api/vehicles/spec?trimId=${TLX_NO_WEIGHT}`))).json();
    expect(body.specSet.identity.weightEstimate.method).toBe("same-model");
    expect(body.specSet.values.curbMassKg.value).toBeNull();
  });
});

describe("restored browser state", () => {
  it("resets a saved 1 lb weight to the published value instead of resurrecting it", () => {
    const baseline = datasetSpecSet(C300());
    const saved = cfg(baseline);
    saved.stock = { ...baseline, values: { ...baseline.values, curbMassKg: { value: lbToKg(1), provenance: "user" } } };
    const { config, fixed } = sanitizeRestored(saved, baseline);
    expect(fixed).toEqual(["Stock vehicle weight (curb)"]);
    expect(config.stock!.values.curbMassKg).toEqual(baseline.values.curbMassKg);
    expect(validateConfig(config).errors).toBe(0);
  });

  it("clears an invalid saved weight on a vehicle without a published weight (asks again)", () => {
    const custom = customSpecSet("Project car", null);
    const saved = cfg(custom);
    saved.stock = { ...custom, values: { ...custom.values, curbMassKg: { value: lbToKg(1), provenance: "user" } } };
    const { config } = sanitizeRestored(saved, custom);
    expect(config.stock!.values.curbMassKg.value).toBeNull();
  });

  it("keeps legitimate saved edits untouched", () => {
    const baseline = datasetSpecSet(C300());
    const saved = cfg(baseline);
    saved.stock = { ...baseline, values: { ...baseline.values, curbMassKg: { value: lbToKg(3300), provenance: "user" } } };
    const { config, fixed } = sanitizeRestored(saved, baseline);
    expect(fixed).toEqual([]);
    expect(config).toEqual(saved);
  });
});

describe("stock vs. modified weight", () => {
  it("modified weight is a change relative to stock; stock keeps its own mass", () => {
    let c = cfg();
    const stockKg = c.stock!.values.curbMassKg.value!;
    c = setModifiedValue({ ...c, modified: { overrides: {} } }, "curbMassKg", { value: stockKg - lbToKg(150), delta: -lbToKg(150), provenance: "user" });
    expect(c.stock!.values.curbMassKg.value).toBe(stockKg);
    expect(kgToLb(effectiveValues(c, "modified")!.curbMassKg.value!)).toBeCloseTo(3417 - 150, 6);
    const r = runAnalysis(c);
    expect(r.modified!.inputs.massKg).toBeCloseTo(r.stock.inputs.massKg - lbToKg(150), 6);
    expect(r.modified!.metrics.zeroTo60S!).toBeLessThan(r.stock.metrics.zeroTo60S!);

    // Correcting the stock weight later keeps the −150 lb modification relative to it.
    c = { ...c, stock: { ...c.stock!, values: { ...c.stock!.values, curbMassKg: { value: lbToKg(3600), provenance: "user" } } } };
    expect(kgToLb(effectiveValues(c, "modified")!.curbMassKg.value!)).toBeCloseTo(3450, 6);
  });

  it("a relative modification of zero removes the override", () => {
    const c = setModifiedValue({ ...cfg(), modified: { overrides: {} } }, "curbMassKg", { value: 0, delta: 0, provenance: "user" });
    expect(c.modified!.overrides.curbMassKg).toBeUndefined();
  });
});
