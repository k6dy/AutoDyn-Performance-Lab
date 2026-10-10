// One authoritative vehicle record everywhere (Gemini context, proposal, review, results, saved),
// sourced data kept distinct from simulated results, and a single live simulation status.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { applyProposal } from "@/lib/ai/apply";
import { buildAssistantContext } from "@/lib/ai/context";
import { stripFalseAttribution } from "@/lib/ai/guards";
import { handleAssistantRequest, type AssistantDeps } from "@/lib/ai/handler";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import type { ModelOutput } from "@/lib/ai/schema";
import type { AssistantResponse } from "@/lib/ai/types";
import { contradictsKnownSpecs, vehicleFacts } from "@/lib/ai/vehicleData";
import { buildCsvReport, buildJsonReport, RESULTS_BASIS } from "@/lib/analysis/export";
import { metricRows } from "@/lib/analysis/metrics";
import { simulationStatus } from "@/lib/analysis/simStatus";
import { resultsSummary } from "@/lib/analysis/summary";
import { effectiveValues } from "@/lib/domain/scenario";
import type { AnalysisConfig } from "@/lib/domain/types";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { IndexedDbRepository } from "@/lib/persistence/repository";
import { parseSaved } from "@/lib/persistence/schema";
import { buildRecord } from "@/lib/persistence/snapshot";
import { runAnalysis } from "@/lib/physics/analysis";
import { resolveInputs } from "@/lib/physics/resolve";
import { simulateRun } from "@/lib/physics/simulate";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";
import { config } from "./support/fixtures";

const FULL =
  "Analyze a stock 2015 Mercedes-Benz C300 4MATIC with the 2.0L turbo engine. Propose a modified version with 60 additional horsepower. Explain what will change and whether the simulation has actually run yet.";
type Contents = { role: string; parts: { text: string }[] }[];
const empty = (): AnalysisConfig => ({ stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } });

const proposalOutput = (reply: string): ModelOutput => ({
  intent: "modify",
  reply,
  vehicle: { mentioned: true, year: 2015, make: "Mercedes-Benz", model: "C300", trim: "4MATIC" },
  useCurrentVehicle: false,
  changes: [{ scenario: "modified", field: "power", operation: "change", value: 60, unit: "hp", option: "", reason: "60 additional horsepower" }],
  view: "compare",
  runSimulation: true,
  followUpQuestion: null,
});
const general = (reply: string): ModelOutput => ({ intent: "general", reply, vehicle: { mentioned: false, year: null, make: null, model: null, trim: null }, useCurrentVehicle: false, changes: [], view: "none", runSimulation: false, followUpQuestion: null });

let n = 0;
async function send(message: string, out: ModelOutput, context = buildAssistantContext(empty(), null, "imperial")) {
  const model = vi.fn<AssistantDeps["callModel"]>(async () => ({ ok: true as const, text: JSON.stringify(out) }));
  const r = await handleAssistantRequest(
    { requestId: `dc${String(++n).padStart(10, "0")}`, message, history: [], context },
    { configured: true, timeoutMs: 500, callModel: model, limiter: new MemoryRateLimiter({ perMinute: 100, perDay: 100, globalPerDay: 100 }), clientKey: "dc", trims: allDatasetTrims, specSetFor: datasetSpecSet, nhtsaModels: async () => [] },
  );
  const turn = model.mock.calls.length ? (model.mock.calls[0][0] as Contents).at(-1)!.parts[0].text : "";
  return { body: r.body as Extract<AssistantResponse, { ok: true }>, model, turn };
}
const vehicleBlock = (turn: string) => JSON.parse(/VEHICLE DATA \([^)]*\): (\[.*\])/.exec(turn)![1]);

describe("vehicle data reaches Gemini from the same record the review panel uses", () => {
  it("the resolved 2015 C300 4MATIC dataset specifications are in the provider turn — before Gemini answers", async () => {
    const { turn, body, model } = await send(FULL, proposalOutput("The modified scenario adds 60 hp."));
    expect(model).toHaveBeenCalledOnce(); // no extra provider call
    const [facts] = vehicleBlock(turn);
    expect(facts).toMatchObject({ requested: expect.stringMatching(/^2015 Mercedes-Benz C300/), status: "matched" });
    expect(facts.vehicles[0].label).toMatch(/2015 Mercedes-Benz C300.*4MATIC/);
    const spec = (f: string) => facts.vehicles[0].specs.find((s: { field: string }) => s.field === f);
    expect(spec("Peak power")).toEqual({ field: "Peak power", value: "241 hp", provenance: "verified" });
    expect(spec("Peak torque")).toEqual({ field: "Peak torque", value: "273 lb·ft", provenance: "verified" });
    expect(spec("Curb weight")).toEqual({ field: "Curb weight", value: "3594 lb", provenance: "verified" });
    expect(facts.note).toMatch(/Never say they are missing/);
    // Exactly the values the proposal (Review changes) loads.
    const v = body.proposal!.vehicle!;
    expect(v.kind).toBe("load");
    if (v.kind === "load") {
      expect(v.specSet.values.curbMassKg.value).toBeCloseTo(3594 * 0.45359237, 6);
      expect(v.label).toBe(facts.vehicles[0].label);
    }
  });

  it("the reply never contradicts known stock data: 'not in the verified dataset' claims are removed", async () => {
    const { body } = await send(FULL, proposalOutput("Exact stock horsepower, torque, and vehicle weight are not present in the verified dataset. The modified scenario adds 60 hp."));
    expect(body.reply).not.toMatch(/not present in the verified dataset/);
    expect(body.reply).toMatch(/The modified scenario adds 60 hp\./);
    // Also with the vehicle already loaded in the workspace.
    const ctx = buildAssistantContext(config(), null, "imperial");
    const r = await send("How much torque does my car make?", general("AutoDyn doesn't have verified torque data for this car. Turbo engines make torque early."), ctx);
    expect(r.body.reply).not.toMatch(/doesn't have verified torque/);
    expect(r.body.reply).toMatch(/Turbo engines make torque early/);
  });

  it("figures quoted from the dataset are not flagged as unverified general knowledge", async () => {
    const { body } = await send(FULL, proposalOutput("AutoDyn's verified dataset lists 241 hp and 273 lb-ft for this trim; the modified scenario adds 60 hp."));
    expect(body.reply).toMatch(/241 hp and 273 lb-ft/);
    expect(body.notices.join(" ")).not.toMatch(/Not verified by AutoDyn/);
  });

  it("a vehicle outside the dataset is labeled unavailable — no values, honest 'missing' statements kept", async () => {
    const { turn, body } = await send("Analyze a 1995 Mazda RX-7 and add 50 hp.", general("AutoDyn's dataset doesn't list horsepower or torque for this car."));
    const [facts] = vehicleBlock(turn);
    expect(facts.status).toBe("not_in_dataset");
    expect(facts.vehicles).toEqual([]);
    expect(facts.note).toMatch(/unavailable in AutoDyn's dataset — don't supply them from memory/);
    expect(body.reply).toMatch(/doesn't list horsepower/); // true here, so it stays
  });

  it("a dataset trim without torque lists it as unavailable; several differing versions are listed, not merged", () => {
    const base = allDatasetTrims().find((t) => t.year === 2015 && /^C 300 4MATIC 4dr/.test(t.description ?? ""))!;
    const noTorque = { ...base, id: "x1", torqueLbFt: null, torqueRpm: null };
    const [f] = vehicleFacts([{ year: 2015, make: "Mercedes-Benz", model: "C300" }], { trims: [noTorque], message: "", units: "imperial" });
    expect(f.vehicles[0].specs.find((s) => s.field === "Peak torque")).toEqual({ field: "Peak torque", value: "not in the dataset", provenance: "unavailable" });
    expect(f.note).toMatch(/does not list peak torque/);
    const [v] = vehicleFacts([{ year: 2015, make: "Mercedes-Benz", model: "C300" }], { trims: allDatasetTrims(), message: "Tell me about the 2015 C300", units: "metric" });
    expect(v.status).toBe("variants");
    expect(v.vehicles.length).toBeGreaterThan(1);
    expect(v.vehicles.every((x) => x.specs.find((s) => s.field === "Peak power")!.value === "180 kW")).toBe(true); // metric display
  });

  it("EPA data can never be cited for horsepower or torque, even when the number is correct", () => {
    const known = "241 hp 273 lb-ft";
    expect(stripFalseAttribution("EPA lists the 2015 C300 at 241 hp. It's rated 28 mpg combined.", known).text).toBe("It's rated 28 mpg combined.");
    expect(stripFalseAttribution("It makes 273 lb-ft according to the EPA.", known).removed).toBe(1);
    expect(stripFalseAttribution("EPA rates the C300 at 28 mpg combined.", known).removed).toBe(0);
    expect(stripFalseAttribution("AutoDyn's verified dataset lists 241 hp.", known).removed).toBe(0);
    expect(contradictsKnownSpecs("EPA data doesn't include horsepower.")).toBe(false); // a correct statement
    expect(contradictsKnownSpecs("Exact horsepower is not in the verified dataset.")).toBe(true);
  });
});

describe("live simulation status", () => {
  const s = (o: Partial<Parameters<typeof simulationStatus>[0]>) => simulationStatus({ hasVehicle: true, pendingProposal: false, running: false, hasResult: false, stale: false, ...o });
  it("proposal pending → configuration applied → running → complete → outdated", () => {
    expect(s({ hasVehicle: false, pendingProposal: true })).toMatchObject({ phase: "proposal_pending", label: "Proposal pending", detail: "No simulation has run for it yet." });
    expect(s({})).toMatchObject({ phase: "configured", label: "Configuration applied", detail: expect.stringMatching(/Not simulated yet/) });
    expect(s({ running: true })).toMatchObject({ phase: "running", label: "Analysis running" });
    expect(s({ hasResult: true })).toMatchObject({ phase: "complete", label: "Analysis complete", detail: "Simulation complete. Results are current." });
    expect(s({ hasResult: true, stale: true })).toMatchObject({ phase: "outdated", label: "Results outdated", detail: "Configuration changed. Rerun the analysis to update results." });
    expect(s({ hasResult: true, pendingProposal: true }).detail).toMatch(/current results cover the applied configuration only/);
    expect(s({ hasVehicle: false }).phase).toBe("no_vehicle");
  });
});

describe("provenance: verified specifications vs simulated results", () => {
  const applied = () => {
    const out = proposalOutput("x");
    const vehicle = datasetSpecSet(allDatasetTrims().find((t) => t.year === 2015 && /^C 300 4MATIC 4dr/.test(t.description ?? ""))!);
    const p = { id: "p", intent: "modify" as const, vehicle: { kind: "load" as const, label: "2015 Mercedes-Benz C300 4MATIC", specSet: vehicle, note: "" }, rejected: [], view: "compare" as const, runAfterApply: true, changes: [{ id: "c0", target: "modified" as const, key: "peakPowerKw" as const, op: "add" as const, value: (60 * 745.699872) / 1000, display: "+60 hp", reason: out.changes[0].reason, statedByUser: true }] };
    return applyProposal(empty(), p, { selected: { c0: true } }).config;
  };

  it("dataset values are Verified, requested changes User-provided, the scaled torque Estimated, metrics Calculated", () => {
    const result = runAnalysis(applied());
    const rows = metricRows(result, "imperial");
    const row = (id: string) => rows.find((r) => r.id === id)!;
    expect(row("power")).toMatchObject({ kind: "input", stockSource: "verified", modifiedSource: "user" });
    expect(row("torque")).toMatchObject({ kind: "input", stockSource: "verified", modifiedSource: "estimated" });
    expect(Math.round(row("torque").modified!)).toBe(341);
    for (const id of ["060", "qm", "trap", "top", "ptw"]) expect(row(id)).toMatchObject({ kind: "calculated", stockSource: "calculated", modifiedSource: "calculated" });
    expect(row("060").modified!).toBeLessThan(row("060").stock!);
    // Metric units keep the same sources.
    expect(metricRows(result, "metric").find((r) => r.id === "power")).toMatchObject({ unit: "kW", stockSource: "verified" });
    // Chat summary and feasibility wording.
    expect(resultsSummary(result, "imperial")).toMatch(/^Simulated results for 2015 Mercedes-Benz C300.*theoretical estimates calculated by AutoDyn, not measured:/);
    expect(resultsSummary(result, "imperial")).not.toMatch(/verified/i);
    expect(result.feasibility.modified!.checks.find((c) => c.id === "mechanical.driveline")!.detail).toMatch(/unverified/);
  });

  it("exports state the results basis and the source of every metric", () => {
    const result = runAnalysis(applied());
    const csv = buildCsvReport(result, "imperial");
    expect(csv).toContain("Results basis");
    expect(csv).toMatch(/Simulated results: theoretical estimates calculated by AutoDyn/);
    expect(csv).toMatch(/Peak power,hp,241,.*Verified dataset specification \(sourced\),User-provided value/);
    expect(csv).toMatch(/Peak torque,lb·ft,273,.*Verified dataset specification \(sourced\),Estimated \(AutoDyn modeling assumption or default\)/);
    expect(csv).toMatch(/0–60 mph,s,.*Calculated by AutoDyn \(simulated output\),Calculated by AutoDyn \(simulated output\)/);
    const json = buildJsonReport(result, "imperial");
    expect(json.resultsBasis).toBe(RESULTS_BASIS);
    expect(json.comparison.find((r) => r.id === "060")).toMatchObject({ kind: "calculated" });
    expect(json.scenarios.modified!.inputs.peakTorqueNm).toMatchObject({ provenance: "estimated", source: "AutoDyn modeling assumption" });
  });

  it("saved records keep the distinctions without a schema change; restored results label identically", async () => {
    const cfg = applied();
    const result = runAnalysis(cfg);
    const record = buildRecord({ result, baseline: cfg.stock, units: "imperial", origin: "auto" });
    const repo = new IndexedDbRepository(new IDBFactory());
    await repo.put(record);
    const back = await repo.get(record.id);
    expect(parseSaved(back).ok).toBe(true);
    expect(metricRows(back.result, "imperial")).toEqual(metricRows(result, "imperial"));
    expect(effectiveValues(back.result.config, "stock")!.peakPowerKw.provenance).toBe("verified");
    expect(effectiveValues(back.result.config, "modified")!.peakTorqueNm.provenance).toBe("estimated");
  });
});

describe("numerical safety", () => {
  it("degenerate inputs never leak NaN or Infinity into metrics, samples or metric rows", () => {
    const r = resolveInputs(config().stock!.values, DEFAULT_CONDITIONS);
    if (!r.ok) throw new Error("unresolved");
    for (const broken of [{ massKg: Number.NaN }, { tireRadiusM: 0 }, { airDensity: Number.POSITIVE_INFINITY }]) {
      const run = simulateRun({ ...r.inputs, ...broken }, { maxTimeS: 5 });
      for (const v of Object.values(run.metrics)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
      expect(run.samples.every((s) => Number.isFinite(s.v) && Number.isFinite(s.x))).toBe(true);
    }
    // Valid runs are unchanged by the guard: identical inputs, identical results.
    expect(simulateRun(r.inputs).metrics).toEqual(simulateRun(r.inputs).metrics);
  });
});
