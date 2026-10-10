// Deterministic preparation of modification scenarios: power/torque consistency, explicit user
// constraints, scenario independence and the full AI → approve → simulate → save workflow.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { applyProposal, evaluateProposal } from "@/lib/ai/apply";
import { handleAssistantRequest, type AssistantDeps } from "@/lib/ai/handler";
import { buildAssistantContext, pendingProposalOf } from "@/lib/ai/context";
import { dropEmptySections, stripStatusClaims } from "@/lib/ai/guards";
import { heldQuantities, holdChanges } from "@/lib/ai/proposal";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import type { ModelOutput } from "@/lib/ai/schema";
import type { AssistantResponse, Proposal, ProposedChange } from "@/lib/ai/types";
import { checkCurve, MODEL_SOURCE, modelPowerTorque, relatedValues } from "@/lib/domain/powerTorque";
import { effectiveValues } from "@/lib/domain/scenario";
import type { AnalysisConfig, SpecSet } from "@/lib/domain/types";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { buildRecord } from "@/lib/persistence/snapshot";
import { IndexedDbRepository } from "@/lib/persistence/repository";
import { parseSaved } from "@/lib/persistence/schema";
import { runAnalysis } from "@/lib/physics/analysis";
import { sampleCurve, torqueAt } from "@/lib/physics/curve";
import { resolveInputs } from "@/lib/physics/resolve";
import { hpToKw, kwToHp, lbftToNm, lbToKg, nmToLbft, rpmToRadS } from "@/lib/units";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";
import { initialState, reducer } from "@/state/reducer";
import { config, ev } from "./support/fixtures";

const HP = (kw: number | null | undefined) => kwToHp(kw ?? NaN);
/** hp = lb·ft × rpm / 5252.11… (= 33,000 / 2π). */
const HP_CONST = 33000 / (2 * Math.PI);
const LBFT = (nm: number | null | undefined) => nmToLbft(nm ?? NaN);

let seq = 0;
function change(c: Partial<ProposedChange> & Pick<ProposedChange, "key" | "op" | "value">): ProposedChange {
  seq += 1;
  return { id: `x${seq}`, target: "modified", display: "", reason: "", statedByUser: true, ...c };
}
function proposalOf(changes: ProposedChange[], vehicle: Proposal["vehicle"] = null): Proposal {
  return { id: `p${++seq}`, intent: "modify", vehicle, changes, rejected: [], view: "compare", runAfterApply: true };
}
const all = (p: Proposal) => Object.fromEntries(p.changes.map((c) => [c.id, true]));
function apply(cfg: AnalysisConfig, changes: ProposedChange[], choice: "scale" | "rpm" | null = null) {
  const p = proposalOf(changes);
  return { p, ...applyProposal(cfg, p, { selected: all(p), curveChoice: choice }) };
}
const mod = (cfg: AnalysisConfig) => effectiveValues(cfg, "modified")!;
const errors = (cfg: AnalysisConfig) => validateConfig(cfg).issues.filter((i) => i.severity === "error");

/** 2015 C300 4MATIC exactly as the bundled dataset resolves it. */
function c300_4matic(): SpecSet {
  const t = allDatasetTrims().find((x) => x.year === 2015 && x.model === "C300" && /^C 300 4MATIC 4dr/.test(x.description ?? ""))!;
  return datasetSpecSet(t);
}

describe("power/torque consistency (deterministic proposal preparation)", () => {
  it("1. the 241 hp / 273 lb·ft stock baseline is valid and keeps its verified provenance", () => {
    const s = c300_4matic();
    expect(HP(s.values.peakPowerKw.value)).toBeCloseTo(241, 6);
    expect(LBFT(s.values.peakTorqueNm.value)).toBeCloseTo(273, 6);
    expect(s.values.peakPowerRpm.value).toBe(5550);
    expect(s.values.peakTorqueNm.provenance).toBe("verified");
    expect(checkCurve(s.values, s.identity)?.ok).toBe(true);
    expect(errors(config(s))).toEqual([]);
  });

  it("reproduces the original failure: +60 hp with torque left at 273 lb·ft is contradictory at 5,550 rpm", () => {
    const cfg = config(c300_4matic());
    const broken: AnalysisConfig = { ...cfg, modified: { overrides: { peakPowerKw: { value: hpToKw(301), provenance: "user" } } } };
    expect(errors(broken).map((e) => e.message).join(" ")).toMatch(/At the 5,550 rpm power peak, the stated power requires more torque than the stated peak torque/);
    // 301 hp at 5,550 rpm needs ≈ 285 lb·ft there (hp = lb·ft × rpm / 5252).
    expect((301 * 5252) / 5550).toBeCloseTo(284.8, 1);
  });

  it("2. +60 hp without torque: the whole torque curve is scaled ×301/241 (estimated) and the scenario validates", () => {
    const cfg = config(c300_4matic());
    const { config: next, curve } = apply(cfg, [change({ key: "peakPowerKw", op: "add", value: hpToKw(60) })]);
    const m = mod(next);
    expect(HP(m.peakPowerKw.value)).toBeCloseTo(301, 6);
    expect(m.peakPowerKw.provenance).toBe("user");
    expect(LBFT(m.peakTorqueNm.value)).toBeCloseTo(273 * (301 / 241), 6); // ≈ 341 lb·ft
    expect(Math.round(LBFT(m.peakTorqueNm.value))).toBe(341);
    expect(m.peakTorqueNm).toMatchObject({ provenance: "estimated", source: MODEL_SOURCE });
    expect(m.peakTorqueNm.note).toMatch(/Hypothetical — not a measured or published figure/);
    expect(curve).toMatchObject({ status: "derived", conflict: null });
    expect(curve!.factor).toBeCloseTo(301 / 241, 12);
    // RPM positions unchanged.
    expect(m.peakPowerRpm.value).toBe(5550);
    expect(m.peakTorqueRpm.value).toBe(1300);
    expect(errors(next)).toEqual([]);
  });

  it("3. +100 hp scales torque by 341/241", () => {
    const { config: next } = apply(config(c300_4matic()), [change({ key: "peakPowerKw", op: "add", value: hpToKw(100) })]);
    expect(HP(mod(next).peakPowerKw.value)).toBeCloseTo(341, 6);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(273 * (341 / 241), 6);
    expect(errors(next)).toEqual([]);
  });

  it("4. a percentage power increase (+20%) scales torque by the same 20%", () => {
    const { config: next } = apply(config(c300_4matic()), [change({ key: "peakPowerKw", op: "scale", value: 1.2 })]);
    expect(HP(mod(next).peakPowerKw.value)).toBeCloseTo(241 * 1.2, 6);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(273 * 1.2, 6);
    expect(errors(next)).toEqual([]);
  });

  it("5. an absolute power target (400 hp) scales torque by 400/241", () => {
    const { config: next } = apply(config(c300_4matic()), [change({ key: "peakPowerKw", op: "set", value: hpToKw(400) })]);
    expect(HP(mod(next).peakPowerKw.value)).toBeCloseTo(400, 6);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(273 * (400 / 241), 6);
    expect(errors(next)).toEqual([]);
  });

  it("6. torque-only (+50 lb·ft): peak power follows the scaled curve and is labeled estimated, not held fixed", () => {
    const { config: next, curve } = apply(config(c300_4matic()), [change({ key: "peakTorqueNm", op: "add", value: lbftToNm(50) })]);
    const m = mod(next);
    expect(LBFT(m.peakTorqueNm.value)).toBeCloseTo(323, 6);
    expect(m.peakTorqueNm.provenance).toBe("user");
    expect(HP(m.peakPowerKw.value)).toBeCloseTo(241 * (323 / 273), 6);
    expect(m.peakPowerKw).toMatchObject({ provenance: "estimated", source: MODEL_SOURCE });
    expect(curve!.assumption).toMatch(/Only torque was specified.*peak power changes with it/);
    expect(errors(next)).toEqual([]);
  });

  it("7. a percentage torque change (+15%) moves power by the same 15%", () => {
    const { config: next } = apply(config(c300_4matic()), [change({ key: "peakTorqueNm", op: "scale", value: 1.15 })]);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(273 * 1.15, 6);
    expect(HP(mod(next).peakPowerKw.value)).toBeCloseTo(241 * 1.15, 6);
  });

  it("8. explicit power AND torque targets are both respected exactly; nothing is modeled", () => {
    const { config: next, curve } = apply(config(c300_4matic()), [
      change({ key: "peakPowerKw", op: "set", value: hpToKw(350) }),
      change({ key: "peakTorqueNm", op: "set", value: lbftToNm(375) }),
    ]);
    expect(HP(mod(next).peakPowerKw.value)).toBeCloseTo(350, 9);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(375, 9);
    expect(mod(next).peakTorqueNm.provenance).toBe("user");
    expect(curve).toMatchObject({ status: "consistent", derived: [] });
    expect(errors(next)).toEqual([]);
  });

  it("9. incompatible explicit targets: a blocking conflict, the stated values untouched, and only approved options resolve it", () => {
    const cfg = config(c300_4matic());
    const changes = [change({ key: "peakPowerKw", op: "set", value: hpToKw(350) }), change({ key: "peakTorqueNm", op: "set", value: lbftToNm(273) })];
    const { config: next, curve } = apply(cfg, changes);
    expect(curve!.status).toBe("conflict");
    expect(curve!.conflict).toMatch(/incompatible: this peak torque could only produce the peak power at 6,733 rpm, above the 6,050 rpm redline \(estimated\)/);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(273, 9); // never silently raised
    expect(errors(next).length).toBeGreaterThan(0); // validation still blocks — not suppressed
    // 350 hp from 273 lb·ft needs ≈ 6,733 rpm — above the 6,050 rpm (estimated) redline, so no rpm option.
    expect(curve!.options.map((o) => o.id)).toEqual(["scale"]);
    const resolved = apply(cfg, changes, "scale");
    expect(resolved.curve!.status).toBe("derived");
    expect(LBFT(mod(resolved.config).peakTorqueNm.value)).toBeCloseTo(273 * (350 / 241), 6);
    expect(errors(resolved.config)).toEqual([]);
  });

  it("10. modified power-peak rpm: '+60 hp, keep 273 lb·ft' can move the power peak to 5,800 rpm (within the redline) once approved", () => {
    const cfg = config(c300_4matic());
    const changes = [change({ key: "peakPowerKw", op: "add", value: hpToKw(60) }), change({ key: "peakTorqueNm", op: "add", value: 0, display: "kept as is" })];
    const blocked = apply(cfg, changes);
    expect(blocked.curve!.status).toBe("conflict");
    expect(blocked.curve!.options.map((o) => o.id)).toEqual(["scale", "rpm"]);
    const { config: next, curve } = apply(cfg, changes, "rpm");
    expect(curve).toMatchObject({ status: "derived", choice: "rpm" });
    const m = mod(next);
    expect(LBFT(m.peakTorqueNm.value)).toBeCloseTo(273, 9);
    expect(m.peakPowerRpm).toMatchObject({ value: 5800, provenance: "estimated" });
    expect(m.redlineRpm).toMatchObject({ value: 6050, provenance: "estimated" }); // only the power peak moves
    expect(errors(next)).toEqual([]);
    const r = resolveInputs(m, DEFAULT_CONDITIONS, next.stock!.identity);
    if (!r.ok) throw new Error("unresolved");
    const peak = Math.max(...sampleCurve(r.inputs.curve, 400).map((p) => p.powerKw));
    expect(HP(peak)).toBeGreaterThan(300.5); // the curve really reaches the requested power
    // A power peak the user fixed is never moved.
    const fixed = modelPowerTorque({ reference: cfg.stock!.values, next: { ...mod(blocked.config) }, fixed: new Set(["peakTorqueNm", "peakPowerRpm"]) });
    expect(fixed.options.map((o) => o.id)).toEqual(["scale"]);
  });

  it("11. extreme input (3,000 hp) is modeled, not rejected: warnings only, finite results, feasibility judged by the engine", () => {
    const { config: next } = apply(config(c300_4matic()), [change({ key: "peakPowerKw", op: "set", value: hpToKw(3000) })]);
    const m = mod(next);
    expect(LBFT(m.peakTorqueNm.value)).toBeCloseTo(273 * (3000 / 241), 6);
    const v = validateConfig(next);
    expect(v.errors).toBe(0);
    expect(v.issues.some((i) => /more than double stock/.test(i.message))).toBe(true);
    const result = runAnalysis(next);
    expect(Number.isFinite(result.modified!.metrics.zeroTo60S!)).toBe(true);
    expect(result.feasibility.modified!.checks.some((c) => c.id === "model.ptw" && c.outcome === "caution")).toBe(true);
    expect(result.feasibility.modified!.checks.find((c) => c.id === "mechanical.driveline")!.detail).toMatch(/unverified/);
  });

  it("12. negative, zero or non-finite power/torque never produce derived values; validation reports them", () => {
    const s = c300_4matic();
    for (const bad of [-50, 0, NaN, Infinity]) {
      const next = { ...s.values, peakPowerKw: { value: bad, provenance: "user" as const } };
      expect(modelPowerTorque({ reference: s.values, next }).derived).toEqual([]);
      const t = { ...s.values, peakPowerKw: { value: hpToKw(301), provenance: "user" as const }, peakTorqueNm: { value: bad, provenance: "user" as const } };
      expect(modelPowerTorque({ reference: s.values, next: t }).derived).toEqual([]);
    }
    const { config: next } = apply(config(s), [change({ key: "peakPowerKw", op: "set", value: -10 })]);
    expect(mod(next).peakTorqueNm.provenance).toBe("verified"); // nothing derived from an invalid power
    expect(errors(next).some((e) => e.key === "peakPowerKw")).toBe(true);
  });

  it("13. unit conversions: kW/N·m requests give the same scenario as hp/lb·ft; weight in lb or kg", () => {
    const cfg = config(c300_4matic());
    const imperial = apply(cfg, [change({ key: "peakPowerKw", op: "add", value: hpToKw(60) })]).config;
    const metric = apply(cfg, [change({ key: "peakPowerKw", op: "add", value: (60 * 745.699872) / 1000 })]).config;
    expect(mod(metric).peakTorqueNm.value).toBeCloseTo(mod(imperial).peakTorqueNm.value!, 9);
    const nm = apply(cfg, [change({ key: "peakTorqueNm", op: "add", value: 67.79 })]).config;
    expect(HP(mod(nm).peakPowerKw.value)).toBeCloseTo(241 * ((273 + 67.79 / 1.3558179483) / 273), 6);
    const lb = apply(cfg, [change({ key: "curbMassKg", op: "add", value: lbToKg(-200) })]).config;
    expect(mod(lb).curbMassKg.value).toBeCloseTo(lbToKg(3594 - 200), 9);
    expect(mod(lb).peakTorqueNm).toBe(cfg.stock!.values.peakTorqueNm); // weight changes never touch the curve
  });

  it("14–15. the modified curve is continuous, non-negative and exactly k × the stock curve; hp = lb·ft × rpm / 5252 everywhere", () => {
    const cfg = config(c300_4matic());
    const { config: next } = apply(cfg, [change({ key: "peakPowerKw", op: "add", value: hpToKw(60) })]);
    const rs = resolveInputs(cfg.stock!.values, DEFAULT_CONDITIONS, cfg.stock!.identity);
    const rm = resolveInputs(mod(next), DEFAULT_CONDITIONS, cfg.stock!.identity);
    if (!rs.ok || !rm.ok) throw new Error("unresolved");
    const k = 301 / 241;
    const pts = sampleCurve(rm.inputs.curve, 300);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      expect(Number.isFinite(p.torqueNm) && p.torqueNm >= 0).toBe(true);
      expect(p.torqueNm).toBeCloseTo(k * torqueAt(rs.inputs.curve, p.rpm), 5);
      expect(kwToHp(p.powerKw)).toBeCloseTo((nmToLbft(p.torqueNm) * p.rpm) / HP_CONST, 6);
      if (i > 0) expect(Math.abs(p.torqueNm - pts[i - 1].torqueNm)).toBeLessThan(0.08 * rm.inputs.curve.peakTorqueNm);
    }
    const peakPower = Math.max(...pts.map((p) => p.powerKw));
    expect(HP(peakPower)).toBeCloseTo(301, 0);
    // Peak torque (1,300 rpm) and torque at the power peak (5,550 rpm) are different values.
    expect(LBFT(torqueAt(rm.inputs.curve, 5550))).toBeCloseTo((301 * HP_CONST) / 5550, 1);
    expect(LBFT(torqueAt(rm.inputs.curve, 1300))).toBeCloseTo(273 * k, 6);
    expect(torqueAt(rm.inputs.curve, 5550) * rpmToRadS(5550)).toBeCloseTo(hpToKw(301) * 1000, 3);
  });

  it("16. identical inputs produce identical scenarios and identical results", () => {
    const cfg = config(c300_4matic());
    const a = apply(cfg, [change({ id: "same", key: "peakPowerKw", op: "add", value: hpToKw(60) })]).config;
    const b = apply(cfg, [change({ id: "same", key: "peakPowerKw", op: "add", value: hpToKw(60) })]).config;
    expect(a).toEqual(b);
    expect(runAnalysis(a).modified!.metrics).toEqual(runAnalysis(b).modified!.metrics);
  });

  it("EVs use the same proportional model (base speed unchanged)", () => {
    const cfg = config(ev());
    const { config: next } = apply(cfg, [change({ key: "peakPowerKw", op: "add", value: 50 })]);
    expect(mod(next).peakTorqueNm.value).toBeCloseTo(420 * (308 / 258), 9);
    expect(errors(next)).toEqual([]);
  });
});

describe("scenario independence and explicit values", () => {
  it("stock never changes; only power and the modeled torque are Modified overrides", () => {
    const cfg = config(c300_4matic());
    const stockBefore = structuredClone(cfg.stock);
    const { config: next } = apply(cfg, [change({ key: "peakPowerKw", op: "add", value: hpToKw(60) })]);
    expect(next.stock).toEqual(stockBefore);
    expect(Object.keys(next.modified!.overrides).sort()).toEqual(["peakPowerKw", "peakTorqueNm"]);
    expect(effectiveValues(next, "stock")).toEqual(stockBefore!.values);
  });

  it("combined: +100 hp and −150 lb validate once as one coherent scenario, each change listed separately", () => {
    const cfg = config(c300_4matic());
    const { config: next, applied, curve } = apply(cfg, [
      change({ key: "peakPowerKw", op: "add", value: hpToKw(100) }),
      change({ key: "curbMassKg", op: "add", value: lbToKg(-150) }),
    ]);
    expect(applied).toHaveLength(2);
    expect(curve!.derived.map((d) => d.key)).toEqual(["peakTorqueNm"]);
    expect(mod(next).curbMassKg.value).toBeCloseTo(lbToKg(3594 - 150), 9);
    expect(errors(next)).toEqual([]);
    const r = runAnalysis(next);
    expect(r.modified!.metrics.zeroTo60S!).toBeLessThan(r.stock.metrics.zeroTo60S!);
  });

  it("Cancel leaves the active configuration untouched", () => {
    let s = reducer({ ...initialState }, { type: "loadVehicle", specSet: c300_4matic() });
    const p = proposalOf([change({ key: "peakPowerKw", op: "add", value: hpToKw(60) })]);
    s = reducer(s, { type: "chatSend", conversationId: "cpt00001", title: null, vehicle: null, message: { id: "r1", role: "user", text: "x", createdAt: 0 } });
    s = reducer(s, { type: "chatReceive", conversationId: "cpt00001", requestId: "r1", proposal: p, message: { id: "a", role: "assistant", text: "ok", createdAt: 0 } });
    const before = s.config;
    s = reducer(s, { type: "proposalCurveChoice", proposalId: p.id, choice: "rpm" });
    s = reducer(s, { type: "proposalCancel", proposalId: p.id });
    expect(s.config).toBe(before);
    expect(s.chat.proposals[p.id].status).toBe("cancelled");
  });

  it("a torque value the user set for Modified earlier is kept when power changes later", () => {
    const cfg = config(c300_4matic());
    const withTorque = apply(cfg, [change({ key: "peakTorqueNm", op: "set", value: lbftToNm(300) }), change({ key: "peakPowerKw", op: "set", value: hpToKw(250) })]).config;
    const { config: next, curve } = apply(withTorque, [change({ key: "peakPowerKw", op: "add", value: hpToKw(51) })]);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(300, 9); // 301 hp at 5,550 rpm needs ≈ 285 lb·ft ≤ 300
    expect(curve!.status).toBe("consistent");
  });

  it("stacked relative changes stay consistent with what the review showed (+60 then +20 hp = 321 hp)", () => {
    const cfg = config(c300_4matic());
    const first = apply(cfg, [change({ key: "peakPowerKw", op: "add", value: hpToKw(60) })]).config;
    const p = proposalOf([change({ key: "peakPowerKw", op: "add", value: hpToKw(20) })]);
    const shown = evaluateProposal(first, p).rows[0];
    const { config: next } = applyProposal(first, p, { selected: all(p) });
    expect(HP(shown.to as number)).toBeCloseTo(321, 6);
    expect(HP(mod(next).peakPowerKw.value)).toBeCloseTo(321, 6);
    expect(LBFT(mod(next).peakTorqueNm.value)).toBeCloseTo(273 * (321 / 241), 6); // re-scaled from the modeled curve
  });

  it("Manual Setup's 'Adjust related values' uses the same model, keeps user values and re-derives stale estimates", () => {
    const s = c300_4matic();
    const cfg: AnalysisConfig = { ...config(s), modified: { overrides: { peakPowerKw: { value: hpToKw(301), delta: hpToKw(60), provenance: "user" } } } };
    const sug = relatedValues(s.values, mod(cfg), s.identity)!;
    expect(sug.derived.map((d) => [d.key, LBFT(d.to)])).toEqual([["peakTorqueNm", expect.closeTo(273 * (301 / 241), 6)]]);
    const ai = apply(config(s), [change({ key: "peakPowerKw", op: "add", value: hpToKw(60) })]).config;
    expect(sug.derived[0].to).toBeCloseTo(mod(ai).peakTorqueNm.value!, 12);
    // After applying, nothing more to suggest; after a later power edit the estimate is refreshed.
    const applied: AnalysisConfig = { ...cfg, modified: { overrides: { ...cfg.modified!.overrides, peakTorqueNm: { value: sug.derived[0].to, provenance: "estimated", source: MODEL_SOURCE } } } };
    expect(relatedValues(s.values, mod(applied), s.identity)).toBeNull();
    const edited: AnalysisConfig = { ...applied, modified: { overrides: { ...applied.modified!.overrides, peakPowerKw: { value: hpToKw(321), provenance: "user" } } } };
    expect(LBFT(relatedValues(s.values, mod(edited), s.identity)!.derived[0].to)).toBeCloseTo(273 * (321 / 241), 6);
    // Power back to stock: the stale modeled torque is offered for reset.
    const reverted: AnalysisConfig = { ...applied, modified: { overrides: { peakTorqueNm: applied.modified!.overrides.peakTorqueNm } } };
    expect(relatedValues(s.values, mod(reverted), s.identity)).toMatchObject({ derived: [], reset: ["peakTorqueNm"] });
    // A torque the user typed for Modified is never replaced.
    const typed: AnalysisConfig = { ...cfg, modified: { overrides: { ...cfg.modified!.overrides, peakTorqueNm: { value: lbftToNm(300), provenance: "user" } } } };
    expect(relatedValues(s.values, mod(typed), s.identity)).toBeNull();
  });
});

describe("hold constraints and reply cleanup", () => {
  it("detects explicit 'keep torque' constraints with or without a value", () => {
    expect(heldQuantities("Add 60 horsepower but keep peak torque at 273 lb-ft.")).toEqual([{ field: "torque", value: 273, unit: "lbft" }]);
    expect(heldQuantities("Add 60 hp, torque unchanged")).toEqual([{ field: "torque", value: null, unit: null }]);
    expect(heldQuantities("+60 hp without changing the torque")).toEqual([{ field: "torque", value: null, unit: null }]);
    expect(heldQuantities("Add 50 lb-ft but keep the same power")).toEqual([{ field: "power", value: null, unit: null }]);
    expect(heldQuantities("Add 60 hp and keep the same torque converter")).toEqual([]);
    expect(heldQuantities("Add 60 hp")).toEqual([]);
    const power = change({ key: "peakPowerKw", op: "add", value: hpToKw(60) });
    const held = holdChanges("Add 60 hp but keep peak torque at 273 lb-ft", [power]);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ key: "peakTorqueNm", op: "set", statedByUser: true });
    expect(LBFT(held[0].value as number)).toBeCloseTo(273, 9);
    expect(holdChanges("keep torque the same", [])).toEqual([]); // only meaningful next to a power/torque change
  });

  it("removes the model's own status statements and drops headings left empty", () => {
    const reply = "### What changes\nThe modified C300 gets 60 more hp.\n\n### Expected Changes\n\n### Simulation status\nThe simulation has not been run yet. Select Apply to Simulation to run it.";
    const st = stripStatusClaims(reply);
    expect(st.removed).toBe(2);
    expect(dropEmptySections(st.text)).toBe("### What changes\nThe modified C300 gets 60 more hp.");
    expect(dropEmptySections("**Expected Changes**\n\n**Notes:**\n- kept")).toBe("**Notes:**\n- kept");
    expect(dropEmptySections("### A\n#### B\ntext")).toBe("### A\n#### B\ntext");
  });
});

describe("complete AI workflow (mocked Gemini)", () => {
  const FULL =
    "Analyze a stock 2015 Mercedes-Benz C300 4MATIC with the 2.0L turbo engine. Propose a modified version with 60 additional horsepower. Explain what will change and whether the simulation has actually run yet.";
  const output = (reply: string): ModelOutput => ({
    intent: "modify",
    reply,
    vehicle: { mentioned: true, year: 2015, make: "Mercedes-Benz", model: "C300", trim: "4MATIC" },
    useCurrentVehicle: false,
    changes: [{ scenario: "modified", field: "power", operation: "change", value: 60, unit: "hp", option: "", reason: "60 additional horsepower" }],
    view: "compare",
    runSimulation: true,
    followUpQuestion: null,
  });
  async function send(message: string, out: ModelOutput) {
    const model = vi.fn<AssistantDeps["callModel"]>(async () => ({ ok: true as const, text: JSON.stringify(out) }));
    const r = await handleAssistantRequest(
      { requestId: `pt${String(++seq).padStart(10, "0")}`, message, history: [], context: buildAssistantContext({ ...config(), stock: null }, null, "imperial") },
      { configured: true, timeoutMs: 500, callModel: model, limiter: new MemoryRateLimiter({ perMinute: 100, perDay: 100, globalPerDay: 100 }), clientKey: "pt", trims: allDatasetTrims, nhtsaModels: async () => [] },
    );
    return { body: r.body as Extract<AssistantResponse, { ok: true }>, model };
  }

  it("1–13. vehicle resolved → +60 hp proposal with estimated torque → valid → approve → simulate → feasibility → save → restore", async () => {
    const { body, model } = await send(
      FULL,
      output("### What changes\nThe modified scenario raises peak power by 60 hp.\n\n### Expected Changes\nIt will run 0-60 in 5.2 s.\n\n### Simulation status\nThe simulation has not been run yet."),
    );
    expect(model).toHaveBeenCalledOnce(); // one provider call, no extra Gemini call to repair values
    const p = body.proposal!;
    expect(p.vehicle?.kind).toBe("load");
    // Empty and duplicated sections are gone; AutoDyn states the status exactly once.
    expect(body.reply).not.toMatch(/Expected Changes|5\.2 s|has not been run yet/);
    expect(body.reply.match(/simulated yet/g)).toHaveLength(1);
    expect(body.reply).toMatch(/^### What changes\nThe modified scenario raises peak power by 60 hp\.\n\n\*\*Simulation status:\*\* No — nothing has been simulated yet\. Review the proposed changes/);
    expect(body.reply).toMatch(/AutoDyn added an estimated torque curve/);

    // Before approval nothing is applied or simulated.
    const empty: AnalysisConfig = { stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } };
    const { config: applied, curve } = applyProposal(empty, p, { selected: all(p) });
    expect(empty.stock).toBeNull();
    expect(curve!.status).toBe("derived");
    const stock = effectiveValues(applied, "stock")!;
    const m = effectiveValues(applied, "modified")!;
    expect(HP(stock.peakPowerKw.value)).toBeCloseTo(241, 6);
    expect(LBFT(stock.peakTorqueNm.value)).toBeCloseTo(273, 6);
    expect(HP(m.peakPowerKw.value)).toBeCloseTo(301, 6);
    expect(Math.round(LBFT(m.peakTorqueNm.value))).toBe(341);
    expect(m.peakTorqueNm.provenance).toBe("estimated");
    expect(validateConfig(applied).errors).toBe(0);

    // The pending context tells the next turn exactly what is proposed (including the estimate).
    const pending = pendingProposalOf([{ proposal: p, status: "pending", selected: all(p), chosen: null }], empty, "imperial");
    expect(pending!.changes).toEqual(["Peak power +60 hp", "Peak torque 341 lb·ft (estimated by AutoDyn's proportional-curve assumption)"]);

    // Approve → deterministic engine.
    const result = runAnalysis(applied);
    expect(result.modified!.metrics.zeroTo60S!).toBeLessThan(result.stock.metrics.zeroTo60S!);
    expect(HP(result.modified!.inputs.curve.peakPowerW / 1000)).toBeCloseTo(301, 6);
    expect(result.modified!.samples.length).toBeGreaterThan(10);
    expect(result.feasibility.stock.status).toBe("feasible");
    expect(result.feasibility.modified!.status).toBe("questionable");
    expect(result.feasibility.modified!.checks.find((c) => c.id === "data.torque")!.detail).toMatch(/modeling assumption.*scaled to match the requested power/);
    expect(result.modified!.estimates.some((e) => e.key === "peakTorqueNm" && /Torque curve scaled/.test(e.reason))).toBe(true);

    // Saved and restored with the approved parameters intact.
    const record = buildRecord({ result, baseline: applied.stock, units: "imperial", origin: "auto" });
    const repo = new IndexedDbRepository(new IDBFactory());
    await repo.put(record);
    const back = await repo.get(record.id);
    expect(parseSaved(back).ok).toBe(true);
    const restoredMod = effectiveValues(back.result.config, "modified")!;
    expect(restoredMod.peakTorqueNm).toEqual(m.peakTorqueNm);
    expect(runAnalysis(back.result.config).modified!.metrics).toEqual(result.modified!.metrics);
  });

  it("'keep peak torque at 273 lb-ft' is enforced even when the model omits it, and the status names the conflict", async () => {
    const { body } = await send("Analyze a stock 2015 Mercedes-Benz C300 4MATIC. Add 60 horsepower but keep peak torque at 273 lb-ft, and tell me if it has run yet.", output("Prepared."));
    const p = body.proposal!;
    expect(p.changes.map((c) => c.key)).toEqual(["peakPowerKw", "peakTorqueNm"]);
    expect(body.reply).toMatch(/\*\*Simulation status:\*\* No — nothing has been simulated yet\. The requested values are incompatible: at the 5,550 rpm power peak.*Choose an option in the proposal below/);
    const empty: AnalysisConfig = { stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } };
    const blocked = applyProposal(empty, p, { selected: all(p) });
    expect(LBFT(effectiveValues(blocked.config, "modified")!.peakTorqueNm.value)).toBeCloseTo(273, 6);
    expect(validateConfig(blocked.config).errors).toBeGreaterThan(0);
    const ok = applyProposal(empty, p, { selected: all(p), curveChoice: "rpm" });
    expect(validateConfig(ok.config).errors).toBe(0);
    expect(LBFT(effectiveValues(ok.config, "modified")!.peakTorqueNm.value)).toBeCloseTo(273, 6);
  });

  it("weight-only and combined requests are prepared as one scenario; stock stays the verified baseline", async () => {
    const out = output("Prepared.");
    out.changes = [
      { scenario: "modified", field: "power", operation: "change", value: 100, unit: "hp", option: "", reason: "100 hp" },
      { scenario: "modified", field: "mass", operation: "change", value: -150, unit: "lb", option: "", reason: "150 lb lighter" },
    ];
    const { body } = await send("Analyze a stock 2015 Mercedes-Benz C300 4MATIC. Add 100 hp, reduce weight by 150 lb, and compare against stock.", out);
    const p = body.proposal!;
    const empty: AnalysisConfig = { stock: null, modified: null, conditions: { ...DEFAULT_CONDITIONS } };
    const { config: applied, curve } = applyProposal(empty, p, { selected: all(p) });
    expect(curve!.derived.map((d) => d.key)).toEqual(["peakTorqueNm"]);
    expect(validateConfig(applied).errors).toBe(0);
    expect(applied.stock!.values.peakTorqueNm.provenance).toBe("verified");
    expect(effectiveValues(applied, "modified")!.curbMassKg.value).toBeCloseTo(lbToKg(3594 - 150), 6);
  });
});
