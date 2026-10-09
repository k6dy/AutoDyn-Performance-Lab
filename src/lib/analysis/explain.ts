// Deterministic engineering explanations generated only from computed results and model inputs.
// These work without any AI provider; the assistant may rephrase them but never replaces them.

import { NUMERIC_FIELDS, SPEC_LABEL } from "@/lib/domain/fields";
import type { NumericSpecKey } from "@/lib/domain/types";
import type { AnalysisResult, ScenarioResult } from "@/lib/physics/analysis";
import { kgToLb, kwToHp, msToMph } from "@/lib/units";

export type Finding = {
  id: string;
  tone: "gain" | "loss" | "limit" | "info" | "confidence";
  title: string;
  detail: string;
};

const s = (v: number, d = 2) => v.toFixed(d);
const pct = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`;
const signed = (v: number, d = 2, unit = "") => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}${unit}`;

function tractionHandoverMph(r: ScenarioResult): number | null {
  const firstPower = r.samples.find((x, i) => i > 0 && x.limit === "power");
  return firstPower ? msToMph(firstPower.v) : null;
}

function dragShareAtTrap(r: ScenarioResult) {
  const v = r.metrics.quarterMileTrapMs;
  if (!v) return null;
  const i = r.inputs;
  const drag = 0.5 * i.airDensity * i.dragCoefficient * i.frontalAreaM2 * v * v;
  const sample = r.samples.reduce((best, x) => (Math.abs(x.v - v) < Math.abs(best.v - v) ? x : best), r.samples[0]);
  const wheelForce = sample && sample.v > 0 ? (sample.wheelPowerKw * 1000) / sample.v : 0;
  return wheelForce > 0 ? drag / wheelForce : null;
}

export function scenarioFindings(r: ScenarioResult, label: string): Finding[] {
  const out: Finding[] = [];
  const m = r.metrics;
  const id = (k: string) => `${r.scenario}-${k}`;
  const hpPerTon = kwToHp(r.inputs.curve.peakPowerW / 1000) / (r.inputs.massKg / 1000);
  const lbPerHp = kgToLb(r.inputs.massKg) / kwToHp(r.inputs.curve.peakPowerW / 1000);

  out.push({
    id: id("ptw"),
    tone: "info",
    title: `${label}: ${s(hpPerTon, 0)} hp per tonne`,
    detail: `${s(lbPerHp, 1)} lb per hp at the ${s(kgToLb(r.inputs.massKg), 0)} lb test mass (curb mass plus driver/payload).`,
  });

  if (m.tractionShareTo60 != null && m.tractionShareTo60 >= 0.25) {
    const handover = tractionHandoverMph(r);
    out.push({
      id: id("traction"),
      tone: "limit",
      title: `${label}: launch is traction-limited`,
      detail: `Tires are at their friction limit for ${s(m.tractionShareTo60 * 100, 0)}% of the 0–60 mph run${
        handover ? `, until about ${s(handover, 0)} mph` : ""
      }. In that phase extra power cannot increase acceleration; grip (μ ${s(r.inputs.tireMu * r.inputs.surfaceFactor)}) and the ${r.inputs.drivetrain} layout set the limit.`,
    });
  }

  const dragShare = dragShareAtTrap(r);
  if (dragShare && dragShare > 0.4) {
    out.push({
      id: id("drag"),
      tone: "limit",
      title: `${label}: aerodynamic drag dominates at speed`,
      detail: `At the ${s(msToMph(m.quarterMileTrapMs!), 0)} mph quarter-mile trap speed, drag absorbs about ${s(dragShare * 100, 0)}% of the wheel force, so gains in Cd·A matter most at high speed.`,
    });
  }

  if (m.shiftsTo60 >= 2 && r.inputs.shiftTimeS > 0) {
    out.push({
      id: id("shifts"),
      tone: "info",
      title: `${label}: ${m.shiftsTo60} upshifts before 60 mph`,
      detail: `Each upshift is modeled as ${s(r.inputs.shiftTimeS)} s without drive torque, about ${s(m.shiftsTo60 * r.inputs.shiftTimeS)} s of the 0–60 time.`,
    });
  }

  if (m.zeroTo60S != null) {
    const lo = r.range.optimistic.zeroTo60S;
    const hi = r.range.conservative.zeroTo60S;
    if (lo != null && hi != null) {
      out.push({
        id: id("range"),
        tone: "confidence",
        title: `${label}: 0–60 mph ${s(m.zeroTo60S)} s (indicative range ${s(lo)}–${s(hi)} s)`,
        detail: `The range reflects uncertainty in the inputs by provenance: verified ratings ±2–3%, user values ±5%, estimates wider. Data quality is ${r.quality.level.toLowerCase()}.`,
      });
    }
  } else {
    out.push({
      id: id("no60"),
      tone: "limit",
      title: `${label}: does not reach 60 mph in the simulation window`,
      detail: "Available power cannot overcome drag and rolling resistance, or gearing limits speed below 60 mph.",
    });
  }

  const estimatedKeys = r.estimates
    .map((e) => e.key)
    .filter((k): k is NumericSpecKey | "gearRatios" => k !== "launchRpm" && ["peakTorqueNm", "gearRatios", "finalDrive", "dragCoefficient", "tireMu", "drivetrainEfficiency"].includes(k));
  if (estimatedKeys.length) {
    const ranked = [...r.sensitivity]
      .filter((x) => x.unfavorable060 != null)
      .sort((a, b) => Math.abs(b.unfavorable060!) - Math.abs(a.unfavorable060!));
    out.push({
      id: id("estimates"),
      tone: "confidence",
      title: `${label}: estimated inputs reduce confidence`,
      detail: `${estimatedKeys
        .map((k) => (k === "gearRatios" ? SPEC_LABEL.gearRatios : NUMERIC_FIELDS[k as NumericSpecKey].label))
        .join(", ")} ${estimatedKeys.length === 1 ? "is" : "are"} estimated.${
        ranked[0] ? ` The result is most sensitive to ${ranked[0].label.toLowerCase()} (${ranked[0].change} → ${signed(ranked[0].unfavorable060!)} s 0–60).` : ""
      } Providing measured values would narrow the range.`,
    });
  }

  if (r.inputs.powertrain === "ev") {
    out.push({
      id: id("ev"),
      tone: "confidence",
      title: `${label}: simplified electric-drive model`,
      detail: "Constant motor torque to base speed, then constant power, through a single reduction gear. Battery state of charge, thermal derating and per-motor torque split are not modeled.",
    });
  } else if (r.inputs.powertrain === "hybrid") {
    out.push({
      id: id("hybrid"),
      tone: "confidence",
      title: `${label}: hybrid modeled with combined system output`,
      detail: "Combined system power and torque are applied through the engine model. Battery state of charge, electric-only operation and power-split behavior are not modeled.",
    });
  }

  if (m.topSpeedMs) {
    out.push({
      id: id("top"),
      tone: "info",
      title: `${label}: theoretical top speed ${s(msToMph(m.topSpeedMs), 0)} mph`,
      detail: `${m.topSpeedLimitedBy === "redline" ? "Limited by gearing at redline" : "Where drag and rolling resistance equal available wheel force"}. Production vehicles are often electronically limited below this; treat it as a model output only.`,
    });
  }

  return out;
}

export function comparisonFindings(result: AnalysisResult): Finding[] {
  const a = result.stock;
  const b = result.modified;
  if (!b) return [];
  const out: Finding[] = [];
  const p0 = a.inputs.curve.peakPowerW;
  const p1 = b.inputs.curve.peakPowerW;
  const m0 = a.inputs.massKg;
  const m1 = b.inputs.massKg;
  const t0 = a.metrics.zeroTo60S;
  const t1 = b.metrics.zeroTo60S;
  const powerPct = ((p1 - p0) / p0) * 100;
  const massPct = ((m1 - m0) / m0) * 100;
  const ptwPct = ((p1 / m1 - p0 / m0) / (p0 / m0)) * 100;

  if (!result.attribution?.length) {
    out.push({ id: "cmp-same", tone: "info", title: "Modified matches stock", detail: "No parameters differ between the scenarios, so results are identical." });
    return out;
  }

  if (t0 != null && t1 != null) {
    const d = t1 - t0;
    const dPct = (d / t0) * 100;
    out.push({
      id: "cmp-060",
      tone: d < -0.005 ? "gain" : d > 0.005 ? "loss" : "info",
      title: `0–60 mph ${d < 0 ? "improves" : d > 0 ? "worsens" : "is unchanged"}: ${s(t0)} → ${s(t1)} s (${signed(d)} s, ${pct(dPct)})`,
      detail: `Power-to-weight changes ${pct(ptwPct)} (power ${pct(powerPct)}, test mass ${pct(massPct)}).${
        a.metrics.quarterMileS && b.metrics.quarterMileS && a.metrics.quarterMileTrapMs && b.metrics.quarterMileTrapMs
          ? ` Quarter mile ${s(a.metrics.quarterMileS)} → ${s(b.metrics.quarterMileS)} s, trap ${s(msToMph(a.metrics.quarterMileTrapMs), 1)} → ${s(msToMph(b.metrics.quarterMileTrapMs), 1)} mph.`
          : ""
      }`,
    });

    if (powerPct > 1 && dPct < 0 && Math.abs(dPct) < powerPct * 0.5) {
      const share = b.metrics.tractionShareTo60 ?? 0;
      out.push({
        id: "cmp-why",
        tone: "limit",
        title: "Acceleration improves less than power",
        detail: `Power rises ${pct(powerPct)} but 0–60 improves only ${pct(Math.abs(dPct))}. ${
          share > 0.2
            ? `The modified car is traction-limited for ${s(share * 100, 0)}% of the 0–60 run, where added power is unusable.`
            : "Shift time, rolling resistance and drag do not scale with power."
        } Elapsed time scales roughly with the cube root of power-to-weight, so a ${pct(ptwPct)} change in power-to-weight would ideally give about ${pct((Math.cbrt(1 + ptwPct / 100) - 1) * -100)} in quarter-mile time.`,
      });
    }
  }

  if (massPct < -0.5) {
    out.push({
      id: "cmp-mass",
      tone: "info",
      title: `Mass reduced ${s(Math.abs(m1 - m0), 0)} kg (${s(kgToLb(Math.abs(m1 - m0)), 0)} lb)`,
      detail: `Lower mass reduces inertia, rolling resistance and the force needed per unit acceleration. In traction-limited phases it also reduces tire normal load, so launch acceleration (peak ${s(
        b.metrics.peakAccelG,
      )} g, set by μ and the driven-axle load) changes little; most of the benefit appears once the car is power-limited.`,
    });
  }

  const items = result.attribution.filter((x) => x.delta060 != null);
  if (items.length > 1 && t0 != null && t1 != null) {
    const sum = items.reduce((acc, x) => acc + (x.delta060 ?? 0), 0);
    out.push({
      id: "cmp-attribution",
      tone: "info",
      title: "Contribution of each change (applied to stock alone)",
      detail: `${items.map((x) => `${x.label}: ${signed(x.delta060!)} s`).join("; ")}. Combined effect ${signed(t1 - t0)} s; interaction between changes ${signed(t1 - t0 - sum)} s.`,
    });
  }

  const tr0 = a.metrics.tractionShareTo60 ?? 0;
  const tr1 = b.metrics.tractionShareTo60 ?? 0;
  if (tr1 - tr0 > 0.1) {
    out.push({
      id: "cmp-traction",
      tone: "limit",
      title: "Modified setup is more traction-limited",
      detail: `Traction-limited share of 0–60 rises from ${s(tr0 * 100, 0)}% to ${s(tr1 * 100, 0)}%. Better tires (higher μ) or AWD would be needed to use the extra output at launch.`,
    });
  }

  return out;
}

export const MODEL_LIMITATIONS = [
  "Results are theoretical estimates from a longitudinal point-mass model on a level road with no wind. They are not guarantees of real-world performance and are not instructions for high-speed driving.",
  "Tires use a constant friction coefficient; slip curves, tire temperature, launch technique, traction control and launch control are not modeled.",
  "Torque curves are synthesized from peak ratings and their rpm points; real curves differ in shape.",
  "AutoDyn does not assess mechanical durability, safety, emissions compliance or road legality of any modification.",
  "Electronic speed limiters are not modeled; theoretical top speed may exceed a vehicle's governed maximum.",
];

export function explainAnalysis(result: AnalysisResult) {
  const findings = [
    ...comparisonFindings(result),
    ...scenarioFindings(result.stock, "Stock"),
    ...(result.modified ? scenarioFindings(result.modified, "Modified") : []),
  ];
  return { findings, limitations: MODEL_LIMITATIONS };
}
