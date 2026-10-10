// Provenance of the mass figures: curb weight (sourced), driver & cargo (assumed unless entered) and
// the test mass derived from both. The derived figure must never inherit a "Verified" badge.
import { describe, expect, it } from "vitest";
import { applyProposal } from "@/lib/ai/apply";
import { buildAssistantContext } from "@/lib/ai/context";
import { contextSchema } from "@/lib/ai/schema";
import { AI_LIMITS } from "@/lib/ai/types";
import { buildCsvReport, buildJsonReport } from "@/lib/analysis/export";
import { inputProvenance, massBasis, metricRows } from "@/lib/analysis/metrics";
import { DEFAULT_CONDITIONS, type AnalysisConfig } from "@/lib/domain/types";
import { runAnalysis, type AnalysisResult } from "@/lib/physics/analysis";
import { parseSaved } from "@/lib/persistence/schema";
import { buildRecord } from "@/lib/persistence/snapshot";
import { hpToKw, kgToLb } from "@/lib/units";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";

/** The confirmed real-world scenario: 2015 C300 4MATIC from the dataset, "+60 hp" applied through the assistant flow. */
function c300Plus60(): AnalysisConfig {
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
  return applyProposal({ stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } }, proposal, { selected: { c0: true } }).config;
}

const row = (result: AnalysisResult, id: string, units: "imperial" | "metric" = "imperial") => metricRows(result, units).find((r) => r.id === id)!;

describe("test mass provenance", () => {
  const result = runAnalysis(c300Plus60());

  it("curb weight is Verified, the driver/cargo allowance is Estimated, and the test mass is Derived from both", () => {
    expect(row(result, "curb")).toMatchObject({ kind: "input", stockSource: "verified", modifiedSource: "verified", stockBasis: null });
    expect(row(result, "payload")).toMatchObject({ kind: "input", stockSource: "estimated", modifiedSource: "estimated" });
    const mass = row(result, "mass");
    expect(mass).toMatchObject({ kind: "input", stockSource: "derived", modifiedSource: "derived" });
    expect(mass.stockBasis).toBe("curb weight (verified) + driver & cargo (estimated)");
    expect(mass.modifiedBasis).toBe("curb weight (verified) + driver & cargo (estimated)");
    expect(mass.note).toMatch(/Curb weight \+ driver & cargo/);
    // The displayed figures: 3,594 lb curb + 176 lb driver = 3,770 lb test mass.
    expect(Math.round(row(result, "curb").stock!)).toBe(3594);
    expect(Math.round(row(result, "payload").stock!)).toBe(176);
    expect(Math.round(mass.stock!)).toBe(3770);
    expect(mass.stock!).toBeCloseTo(row(result, "curb").stock! + row(result, "payload").stock!, 9);
    expect(row(result, "mass", "metric").stockSource).toBe("derived");
    // The weight-to-power row is a calculation on the test mass, not an input.
    expect(row(result, "ptw")).toMatchObject({ kind: "calculated", stockSource: "calculated" });
    // Nothing else changed: sourced power and the user-requested target keep their labels.
    expect(row(result, "power")).toMatchObject({ stockSource: "verified", modifiedSource: "user" });
    expect(row(result, "torque")).toMatchObject({ stockSource: "verified", modifiedSource: "estimated" });
  });

  it("exports say the same: CSV source columns and the JSON legend never call the test mass verified", () => {
    const csv = buildCsvReport(result, "imperial");
    const massLine = csv.split("\r\n").find((l) => l.startsWith("Test mass,"))!;
    expect(massLine).toMatch(/Derived input: curb weight \(verified\) \+ driver & cargo \(estimated\)/);
    expect(massLine).not.toMatch(/Verified dataset/);
    expect(csv).toMatch(/^Curb weight,lb,3594,.*Verified dataset specification/m);
    expect(csv).toMatch(/^Driver & cargo,lb,176,.*Estimated \(AutoDyn modeling assumption or default\)/m);
    expect(csv).toMatch(/^Rounding,/m);
    const json = buildJsonReport(result, "imperial");
    expect(json.provenanceLegend.derived).toMatch(/Derived input/);
    expect(json.deltaRounding).toMatch(/rounded/);
    const massRow = json.comparison.find((r) => r.id === "mass")!;
    expect(massRow).toMatchObject({ stockSource: "derived", stockBasis: "curb weight (verified) + driver & cargo (estimated)" });
    expect(json.scenarios.stock!.inputs.payloadKg.provenance).toBe("estimated");
    expect(json.scenarios.stock!.inputs.curbMassKg.provenance).toBe("verified");
  });

  it("a driver/cargo value the user enters is User-provided and the test-mass basis says so", () => {
    const cfg = c300Plus60();
    cfg.stock!.values.payloadKg = { value: 100, provenance: "user", source: "User input" };
    const r = runAnalysis(cfg);
    expect(row(r, "payload").stockSource).toBe("user");
    expect(row(r, "mass").stockBasis).toBe("curb weight (verified) + driver & cargo (user-provided)");
    expect(Math.round(row(r, "mass").stock!)).toBe(Math.round(kgToLb(cfg.stock!.values.curbMassKg.value! + 100)));
  });

  it("an estimated curb weight makes the test mass basis say so, never verified", () => {
    const cfg = c300Plus60();
    cfg.stock!.values.curbMassKg = { ...cfg.stock!.values.curbMassKg, provenance: "estimated", source: "AutoDyn estimate" };
    const r = runAnalysis(cfg);
    expect(row(r, "curb").stockSource).toBe("estimated");
    expect(row(r, "mass").stockBasis).toBe("curb weight (estimated) + driver & cargo (estimated)");
  });

  it("saved records keep the derivation; a record stored before this release labels identically", async () => {
    const record = buildRecord({ result, baseline: result.config.stock, units: "imperial", origin: "auto" });
    const parsed = parseSaved(JSON.parse(JSON.stringify(record)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(metricRows(parsed.record.result, "imperial")).toEqual(metricRows(result, "imperial"));
    // Older records carry the same provenance map; even without a payload entry the fallback is the estimate list.
    const legacy = structuredClone(parsed.record.result);
    delete legacy.stock.provenance.payloadKg;
    expect(inputProvenance(legacy.stock, "payloadKg")).toBe("estimated");
    expect(massBasis(legacy.stock)).toBe("curb weight (verified) + driver & cargo (estimated)");
    expect(row(legacy, "mass").stockSource).toBe("derived");
  });

  it("the assistant sees the split rows too, within the context limits", () => {
    const context = buildAssistantContext(result.config, { analysis: result, stale: false }, "imperial");
    const labels = context.results!.metrics.map((m) => m.metric);
    expect(labels).toEqual(expect.arrayContaining(["Curb weight", "Driver & cargo", "Test mass"]));
    expect(context.results!.metrics.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(context).length).toBeLessThan(AI_LIMITS.maxContextChars);
    expect(contextSchema.safeParse(context).success).toBe(true);
    expect(context.stockSpecs.find((s) => s.field === "Driver & cargo")!.provenance).toBe("unavailable"); // not set by the user: the resolver's default applies
    expect(context.results!.estimatedInputs.join(" ")).toMatch(/Driver & cargo: One 80 kg driver/);
  });
});
