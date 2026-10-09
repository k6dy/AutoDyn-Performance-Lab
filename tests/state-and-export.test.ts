import { describe, expect, it } from "vitest";
import { buildCsvReport, buildJsonReport, buildTraceCsv } from "@/lib/analysis/export";
import { metricRows, rowDelta } from "@/lib/analysis/metrics";
import { runAnalysis } from "@/lib/physics/analysis";
import { hpToKw } from "@/lib/units";
import { initialState, isStale, reducer, type AppState } from "@/state/reducer";
import { c300, ev } from "./support/fixtures";

const user = (value: number) => ({ value, provenance: "user" as const });

function loaded(): AppState {
  return reducer(initialState, { type: "loadVehicle", specSet: c300() });
}

describe("application state", () => {
  it("switching modes preserves configuration, scenario and results", () => {
    let s = loaded();
    s = reducer(s, { type: "createModified" });
    s = reducer(s, { type: "setModifiedValue", key: "peakPowerKw", value: user(hpToKw(300)) });
    const config = s.config;
    for (const mode of ["assistant", "results", "manual", "assistant"] as const) s = reducer(s, { type: "setMode", mode });
    expect(s.config).toBe(config);
    expect(s.ui.editing).toBe("modified");
  });

  it("edits to Modified never change Stock", () => {
    let s = loaded();
    const stock = s.config.stock;
    s = reducer(s, { type: "setModifiedValue", key: "curbMassKg", value: user(1400) });
    expect(s.config.stock).toBe(stock);
    expect(s.config.modified!.overrides.curbMassKg!.value).toBe(1400);
  });

  it("marks results stale when any input changes and ignores results for older revisions", () => {
    let s = loaded();
    s = reducer(s, { type: "requestRun", navigate: true });
    expect(s.runRequest).not.toBeNull();
    const analysis = runAnalysis(s.config);
    const rev = s.revision;
    s = reducer(s, { type: "runComplete", analysis, revision: rev });
    expect(isStale(s)).toBe(false);
    expect(s.ui.mode).toBe("results");
    s = reducer(s, { type: "setStockValue", key: "tireMu", value: user(1.1) });
    expect(isStale(s)).toBe(true);
    const old = s.result;
    s = reducer(s, { type: "runComplete", analysis, revision: rev });
    expect(s.result).toBe(old); // older revision ignored
  });

  it("refuses to request a run while validation errors exist", () => {
    let s = loaded();
    s = reducer(s, { type: "setStockValue", key: "curbMassKg", value: user(-5) });
    s = reducer(s, { type: "requestRun", navigate: true });
    expect(s.runRequest).toBeNull();
  });

  it("reset restores source data predictably", () => {
    let s = loaded();
    const original = s.config.stock!.values.peakPowerKw;
    s = reducer(s, { type: "setStockValue", key: "peakPowerKw", value: user(150) });
    s = reducer(s, { type: "resetField", scenario: "stock", key: "peakPowerKw" });
    expect(s.config.stock!.values.peakPowerKw).toEqual(original);
    s = reducer(s, { type: "createModified" });
    s = reducer(s, { type: "setModifiedValue", key: "peakPowerKw", value: user(200) });
    s = reducer(s, { type: "resetField", scenario: "modified", key: "peakPowerKw" });
    expect(s.config.modified!.overrides.peakPowerKw).toBeUndefined();
    s = reducer(s, { type: "setStockValue", key: "tireMu", value: user(1.2) });
    s = reducer(s, { type: "resetStock" });
    expect(s.config.stock).toBe(s.baseline);
  });

  it("changing vehicle replaces stock and clears the dependent modified scenario", () => {
    let s = loaded();
    s = reducer(s, { type: "createModified" });
    s = reducer(s, { type: "loadVehicle", specSet: ev() });
    expect(s.config.stock!.identity.model).toBe("EV");
    expect(s.config.modified).toBeNull();
    expect(s.ui.editing).toBe("stock");
  });

  it("guards against duplicate chat submissions and stale responses", () => {
    let s = loaded();
    s = reducer(s, { type: "chatSend", message: { id: "a1", role: "user", text: "one", createdAt: 0 } });
    const after = reducer(s, { type: "chatSend", message: { id: "a2", role: "user", text: "two", createdAt: 0 } });
    expect(after.chat.messages).toHaveLength(1);
    const stale = reducer(s, { type: "chatReceive", requestId: "zzz", proposal: null, message: { id: "x", role: "assistant", text: "late", createdAt: 0 } });
    expect(stale).toBe(s);
  });

  it("an applied proposal can only be applied once", () => {
    let s = loaded();
    s = reducer(s, { type: "chatSend", message: { id: "r", role: "user", text: "x", createdAt: 0 } });
    const proposal = { id: "p", intent: "modify" as const, vehicle: null, changes: [], rejected: [], view: null, runAfterApply: false };
    s = reducer(s, { type: "chatReceive", requestId: "r", proposal, message: { id: "m", role: "assistant", text: "", createdAt: 0 } });
    const cfg = { ...s.config, modified: { overrides: {} } };
    s = reducer(s, { type: "proposalApplied", proposalId: "p", config: cfg, baseline: null, view: null });
    const rev = s.revision;
    s = reducer(s, { type: "proposalApplied", proposalId: "p", config: cfg, baseline: null, view: null });
    expect(s.revision).toBe(rev);
  });
});

describe("reports and export", () => {
  const cfg = loaded().config;
  cfg.modified = { overrides: { peakPowerKw: user(hpToKw(281)) } };
  const result = runAnalysis(cfg);

  it("metric rows derive from computed results with correct deltas", () => {
    const rows = metricRows(result, "imperial");
    const p = rows.find((r) => r.id === "power")!;
    expect(p.stock).toBeCloseTo(241, 6);
    expect(p.modified).toBeCloseTo(281, 6);
    expect(rowDelta(p)!.abs).toBeCloseTo(40, 6);
    const t = rows.find((r) => r.id === "060")!;
    expect(t.stock).toBe(result.stock.metrics.zeroTo60S);
    expect(rowDelta(t)!.improved).toBe(true);
  });

  it("JSON report includes provenance, assumptions, findings and limitations", () => {
    const json = buildJsonReport(result, "imperial");
    expect(json.scenarios.stock!.inputs.peakPowerKw.provenance).toBe("verified");
    expect(json.scenarios.modified!.inputs.peakPowerKw.provenance).toBe("user");
    expect(json.scenarios.stock!.estimatesUsed.length).toBeGreaterThan(0);
    expect(json.findings.length).toBeGreaterThan(0);
    expect(json.limitations.length).toBeGreaterThan(0);
  });

  it("CSV exports are well-formed and neutralize formula injection", () => {
    const csv = buildCsvReport(result, "metric");
    expect(csv).toMatch(/^AutoDyn analysis/);
    expect(csv).toMatch(/0–60 mph,s,/);
    const injected = runAnalysis({ ...cfg, stock: { ...cfg.stock!, identity: { ...cfg.stock!.identity, year: null, make: "=HYPERLINK(1)" } } });
    expect(buildCsvReport(injected, "metric")).toMatch(/'=HYPERLINK|"'=HYPERLINK/);
    const trace = buildTraceCsv(result, "imperial").split("\r\n");
    expect(trace[0]).toMatch(/Speed \(mph\)/);
    expect(trace.length).toBe(result.stock.samples.length + result.modified!.samples.length + 1);
  });
});
