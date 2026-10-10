// Deterministic engineering feasibility assessment. Pure functions of validated inputs and the
// physics engine's results — no AI, no network, no clock. Every non-pass outcome names the
// constraint, the quantities involved and the assumption it depends on.

import { SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveConstraints, effectiveValues } from "@/lib/domain/scenario";
import type { AnalysisConfig, Provenance, ScenarioConstraints, ScenarioId, SpecKey, SpecValues, VehicleIdentity } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { drivenAxleShare, launchAccelBound, launchForceRatio, maxSpeedByPower, minZeroTo60 } from "@/lib/feasibility/bounds";
import {
  FEASIBILITY_ENGINE_VERSION,
  FEASIBILITY_HEADLINE,
  type CheckCategory,
  type ConstraintCheck,
  type FeasibilityAssessment,
  type FeasibilityStatus,
  type ScenarioAssessment,
} from "@/lib/feasibility/types";
import type { ScenarioResult } from "@/lib/physics/analysis";
import { resolveInputs, type ResolvedInputs } from "@/lib/physics/resolve";
import { G, kgToLb, kwToHp, msToMph, nmToLbft, radSToRpm } from "@/lib/units";

// ---- Documented reference values (not pass/fail thresholds on their own) ----------------------
/** Highest common street-tire speed rating (Y): 300 km/h ≈ 186 mph. Beyond it the model's tire,
 *  lift and stability assumptions are unverified. */
const STREET_TIRE_MAX_MS = 300 / 3.6;
/** Production road-car hypercars reach ≈ 550–620 W/kg; above this the constant-μ point-mass model
 *  (no aero load, no tire load sensitivity) has no validation basis. */
const VALIDATED_POWER_TO_WEIGHT_WKG = 600;
/** Highest specific output of current production engines ≈ 210 hp/L (e.g. 2.0 L turbo at 416–421 hp). */
const PRODUCTION_MAX_HP_PER_L = 215;
/** Street tires seldom exceed μ ≈ 1.4 on dry asphalt without racing compounds or prepared surfaces. */
const STREET_GRIP_LIMIT = 1.4;
/** Production road vehicles span roughly 0.45–1.6 m² drag area (Cd·A). */
const CDA_RANGE: [number, number] = [0.4, 1.8];

const CATEGORY_PRIORITY: CheckCategory[] = ["claims", "mechanical", "traction", "data", "powertrain", "mass", "aero", "model", "acceleration"];

const f = {
  s: (v: number) => `${v.toFixed(2)} s`,
  g: (a: number) => `${(a / G).toFixed(2)} g`,
  speed: (ms: number) => `${ms.toFixed(1)} m/s (${msToMph(ms).toFixed(0)} mph)`,
  power: (w: number) => `${(w / 1000).toFixed(1)} kW (${kwToHp(w / 1000).toFixed(0)} hp)`,
  torque: (nm: number) => `${nm.toFixed(0)} N·m (${nmToLbft(nm).toFixed(0)} lb·ft)`,
  mass: (kg: number) => `${kg.toFixed(0)} kg (${kgToLb(kg).toFixed(0)} lb)`,
  pct: (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`,
};

export type AssessInput = {
  scenario: ScenarioId;
  values: SpecValues;
  identity: VehicleIdentity;
  constraints: ScenarioConstraints;
  rollout: boolean;
  result: ScenarioResult;
  /** Stock result, when assessing Modified (for changes relative to stock). */
  stock?: ScenarioResult | null;
};

function prov(r: ScenarioResult, values: SpecValues, key: SpecKey): Provenance {
  return r.provenance[key] ?? (values[key].value == null ? "unavailable" : values[key].provenance);
}

/** Optimistic-but-defensible variant of the inputs for bounds: wider margins for estimated values. */
function optimistic(inp: ResolvedInputs, p: (k: SpecKey) => Provenance): ResolvedInputs {
  const est = (k: SpecKey) => p(k) === "estimated";
  return {
    ...inp,
    tireMu: inp.tireMu * (est("tireMu") ? 1.15 : 1.05),
    dragCoefficient: inp.dragCoefficient * (est("dragCoefficient") ? 0.9 : 0.97),
    frontalAreaM2: inp.frontalAreaM2 * (est("frontalAreaM2") ? 0.92 : 0.97),
    drivetrainEfficiency: Math.min(0.99, inp.drivetrainEfficiency + (est("drivetrainEfficiency") ? 0.03 : 0.01)),
    rollingResistance: inp.rollingResistance * (est("rollingResistance") ? 0.75 : 0.9),
    curve: { ...inp.curve, peakPowerW: inp.curve.peakPowerW * (p("peakPowerKw") === "verified" ? 1.03 : 1.05) },
  };
}

function displacementL(identity: VehicleIdentity): number | null {
  const m = identity.engineDescription?.match(/(\d+(?:\.\d+)?)\s*L\b/);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v > 0.5 && v < 10 ? v : null;
}

export function assessScenario(a: AssessInput): FeasibilityAssessment {
  const { result: r, values, scenario } = a;
  const inp = r.inputs;
  const p = (k: SpecKey) => prov(r, values, k);
  const checks: ConstraintCheck[] = [];
  const add = (c: ConstraintCheck) => checks.push(c);
  const m = r.metrics;
  const isEv = inp.powertrain === "ev";

  // --- Data confidence -----------------------------------------------------------------------
  const estimatedCore = (["curbMassKg", "peakTorqueNm", "drivetrain", "transmission"] as SpecKey[]).filter((k) => p(k) === "estimated");
  const massSens = r.sensitivity.find((s) => s.id === "mass");
  if (p("curbMassKg") === "estimated") {
    add({
      id: "data.mass",
      category: "data",
      label: "Vehicle weight source",
      outcome: "caution",
      detail: `Vehicle weight is an accepted estimate, not a published figure${massSens?.unfavorable060 != null ? `; ±10% weight moves 0–60 by about ${Math.abs(massSens.unfavorable060).toFixed(2)} s` : ""}.`,
      values: [{ label: "Curb weight (estimated)", value: f.mass(inp.curbMassKg) }],
      suggestion: "Enter the measured or published curb weight.",
    });
  } else {
    add({ id: "data.mass", category: "data", label: "Vehicle weight source", outcome: "pass", detail: `Curb weight is ${p("curbMassKg") === "verified" ? "a published specification" : "user-provided"}.`, values: [{ label: "Curb weight", value: f.mass(inp.curbMassKg) }] });
  }
  if (p("peakTorqueNm") === "estimated") {
    add({
      id: "data.torque",
      category: "data",
      label: "Torque source",
      outcome: "caution",
      detail: "Peak torque was estimated from power, so the low- and mid-rpm thrust that dominates launch is uncertain.",
      values: [{ label: "Peak torque (estimated)", value: f.torque(inp.curve.peakTorqueNm) }],
      suggestion: "Provide the rated peak torque.",
    });
  }
  if (p("drivetrain") === "estimated") {
    add({ id: "data.drivetrain", category: "data", label: "Driven wheels", outcome: "caution", detail: `Driven wheels were assumed (${inp.drivetrain}); launch traction depends strongly on this.`, suggestion: "Select the actual drivetrain." });
  }

  // --- Powertrain consistency ------------------------------------------------------------------
  const P = inp.curve.peakPowerW;
  const T = inp.curve.peakTorqueNm;
  if (isEv) {
    add({
      id: "powertrain.consistency",
      category: "powertrain",
      label: "Power/torque relationship",
      outcome: "pass",
      detail: `Electric drive modeled as ${f.torque(T)} up to ${Math.round(inp.curve.peakPowerRpm).toLocaleString()} rpm, then constant ${f.power(P)}.`,
    });
    add({ id: "powertrain.battery", category: "powertrain", label: "Battery and motor thermal limits", outcome: "not_assessed", detail: "Battery power, state of charge and motor thermal derating are not modeled." });
  } else {
    const rpmNeeded = radSToRpm(P / T);
    const torqueAtPowerPeak = P / ((inp.curve.peakPowerRpm * 2 * Math.PI) / 60);
    const nearLimit = rpmNeeded > inp.curve.redlineRpm * 0.97;
    add({
      id: "powertrain.consistency",
      category: "powertrain",
      label: "Power/torque relationship",
      outcome: nearLimit ? "caution" : "pass",
      detail: nearLimit
        ? `Peak power is only reachable within 3% of the ${Math.round(inp.curve.redlineRpm).toLocaleString()} rpm limit, implying an unusually flat torque curve to redline.`
        : `Peak power implies ${f.torque(torqueAtPowerPeak)} at ${Math.round(inp.curve.peakPowerRpm).toLocaleString()} rpm, within the ${f.torque(T)} peak.`,
      values: [
        { label: "Peak power", value: f.power(P) },
        { label: "Peak torque", value: f.torque(T) },
        { label: "Lowest rpm able to make peak power", value: `${Math.round(rpmNeeded).toLocaleString()} rpm` },
        { label: "Redline", value: `${Math.round(inp.curve.redlineRpm).toLocaleString()} rpm` },
      ],
    });
    const disp = displacementL(a.identity);
    if (disp) {
      const hpPerL = kwToHp(P / 1000) / disp;
      add({
        id: "powertrain.specific",
        category: "powertrain",
        label: "Specific output",
        outcome: hpPerL > PRODUCTION_MAX_HP_PER_L ? "caution" : "pass",
        detail:
          hpPerL > PRODUCTION_MAX_HP_PER_L
            ? `${hpPerL.toFixed(0)} hp/L from ${disp.toFixed(1)} L exceeds current production engines (≈ 210 hp/L); internal, boost and fuel-system changes would be needed and are not described.`
            : `${hpPerL.toFixed(0)} hp/L from ${disp.toFixed(1)} L is within production-engine experience.`,
        suggestion: hpPerL > PRODUCTION_MAX_HP_PER_L ? "Document the engine hardware that supports this output." : undefined,
      });
    }
  }

  // --- Mass change (Modified) -------------------------------------------------------------------
  if (scenario === "modified" && a.stock) {
    const change = inp.curbMassKg / a.stock.inputs.curbMassKg - 1;
    if (Math.abs(change) > 1e-6) {
      add({
        id: "mass.change",
        category: "mass",
        label: "Weight change vs. stock",
        outcome: change < -0.15 ? "caution" : "pass",
        detail:
          change < -0.15
            ? `Weight is ${f.pct(change)} vs. stock. Reductions beyond ~15% usually need structural or material changes whose safety and stiffness are not assessed.`
            : `Weight change of ${f.pct(change)} vs. stock is applied to every calculation.`,
        values: [{ label: "Curb weight", value: `${f.mass(a.stock.inputs.curbMassKg)} → ${f.mass(inp.curbMassKg)}` }],
      });
    }
  }

  // --- Traction ---------------------------------------------------------------------------------
  const muEff = inp.tireMu * inp.surfaceFactor;
  const aBound = launchAccelBound(inp);
  const ratio = launchForceRatio(inp);
  const share = m.tractionShareTo60 ?? 0;
  const grip = r.sensitivity.find((s) => s.id === "grip");
  const gripRel = grip?.unfavorable060 != null && m.zeroTo60S ? Math.abs(grip.unfavorable060) / m.zeroTo60S : 0;
  const tractionValues = [
    { label: "Effective grip μ (tire × surface)", value: muEff.toFixed(2) },
    { label: "Driven-wheel load share at launch", value: `${(drivenAxleShare(inp) * 100).toFixed(0)}% (${inp.drivetrain})` },
    { label: "Launch acceleration bound", value: f.g(aBound) },
    { label: "Drive force ÷ grip at launch", value: Number.isFinite(ratio) ? `${ratio.toFixed(2)}×` : "∞" },
    { label: "Traction-limited share of 0–60", value: `${(share * 100).toFixed(0)}%` },
  ];
  if (ratio > 3) {
    add({
      id: "traction.launch",
      category: "traction",
      label: "Available traction vs. drive force",
      outcome: "caution",
      detail: `At launch the drivetrain can deliver ${ratio.toFixed(1)}× the force the tires can transmit (μ ${muEff.toFixed(2)}). Real launches at this ratio depend on traction control and technique, which are not modeled.`,
      values: tractionValues,
      suggestion: "Specify the tire grip (μ) for the tires you intend to use, or a prepared surface.",
    });
  } else if (share >= 0.5 && p("tireMu") === "estimated" && gripRel >= 0.05) {
    add({
      id: "traction.launch",
      category: "traction",
      label: "Available traction vs. drive force",
      outcome: "caution",
      detail: `${(share * 100).toFixed(0)}% of the 0–60 run is traction-limited and grip is an assumed μ ${inp.tireMu.toFixed(2)}: ±10% grip moves 0–60 by ${Math.abs(grip!.unfavorable060!).toFixed(2)} s. The result is driven by the traction assumption.`,
      values: tractionValues,
      suggestion: "Enter tire grip for the actual tires in Advanced Settings.",
    });
  } else {
    add({ id: "traction.launch", category: "traction", label: "Available traction vs. drive force", outcome: "pass", detail: `Traction-limited for ${(share * 100).toFixed(0)}% of the 0–60 run under μ ${muEff.toFixed(2)}.`, values: tractionValues });
  }
  if (muEff > STREET_GRIP_LIMIT) {
    add({
      id: "traction.grip",
      category: "traction",
      label: "Tire/road grip level",
      outcome: "caution",
      detail: `Effective grip μ ${muEff.toFixed(2)} exceeds what street tires achieve on dry asphalt (≈ ${STREET_GRIP_LIMIT}); it implies racing tires or a prepared surface. Tire load sensitivity is not modeled.`,
    });
  }

  // --- Aerodynamics & speed range ---------------------------------------------------------------
  const cda = inp.dragCoefficient * inp.frontalAreaM2;
  if (cda < CDA_RANGE[0] || cda > CDA_RANGE[1]) {
    add({
      id: "aero.cda",
      category: "aero",
      label: "Drag area",
      outcome: "caution",
      detail: `Drag area Cd·A ${cda.toFixed(2)} m² is outside production road vehicles (≈ 0.45–1.6 m²); verify the aerodynamic inputs.`,
    });
  }
  if (m.topSpeedMs == null) {
    add({ id: "aero.speed", category: "aero", label: "Speed range of the model", outcome: "caution", detail: "Predicted top speed is beyond the model's range (> 160 m/s / 358 mph); aerodynamic lift, stability and tire limits dominate there and are not modeled." });
  } else if (m.topSpeedMs > STREET_TIRE_MAX_MS) {
    add({
      id: "aero.speed",
      category: "aero",
      label: "Speed range of the model",
      outcome: "caution",
      detail: `Theoretical top speed ${f.speed(m.topSpeedMs)} exceeds the highest common street-tire rating (Y, 186 mph). Aerodynamic lift, stability and tire limits are not modeled at these speeds.`,
    });
  } else {
    add({ id: "aero.speed", category: "aero", label: "Speed range of the model", outcome: "pass", detail: `Theoretical top speed ${f.speed(m.topSpeedMs)} (${m.topSpeedLimitedBy === "redline" ? "gearing-limited" : "drag-limited"}).` });
  }

  // --- Acceleration envelope ---------------------------------------------------------------------
  if (m.zeroTo60S == null) {
    add({ id: "acceleration.envelope", category: "acceleration", label: "Acceleration envelope", outcome: "pass", detail: "The vehicle does not reach 60 mph in the simulation window: available force is balanced by drag and rolling resistance first." });
  } else {
    const tMin = minZeroTo60(inp, a.rollout);
    const consistent = m.peakAccelG * G <= aBound * 1.02 + 1e-6 && m.zeroTo60S >= tMin - 1e-6;
    add({
      id: "acceleration.envelope",
      category: "acceleration",
      label: "Acceleration envelope",
      outcome: consistent ? "pass" : "caution",
      detail: consistent
        ? `Simulated 0–60 ${f.s(m.zeroTo60S)} respects the traction-limited minimum of ${f.s(tMin)} under μ ${muEff.toFixed(2)}.`
        : "Simulated acceleration exceeds the traction bound; treat the result as unreliable.",
      values: [
        { label: "Simulated 0–60 mph", value: f.s(m.zeroTo60S) },
        { label: "Indicative range", value: r.range.optimistic.zeroTo60S && r.range.conservative.zeroTo60S ? `${f.s(r.range.optimistic.zeroTo60S)} – ${f.s(r.range.conservative.zeroTo60S)}` : "n/a" },
        { label: "Traction-limited minimum", value: f.s(tMin) },
      ],
    });
  }

  // --- Performance claims ------------------------------------------------------------------------
  const c = a.constraints;
  const opt = optimistic(inp, p);
  if (c.claimedZeroTo60S != null) {
    const claim = c.claimedZeroTo60S;
    const tMinOpt = minZeroTo60(opt, a.rollout);
    const tMinNom = minZeroTo60(inp, a.rollout);
    const best = r.range.optimistic.zeroTo60S;
    const needG = (60 * 0.44704) / claim / G;
    const values = [
      { label: "Claimed 0–60 mph", value: f.s(claim) },
      { label: "Average acceleration required", value: `${needG.toFixed(2)} g` },
      { label: "Traction-limited minimum (optimistic grip)", value: f.s(tMinOpt) },
      { label: "Simulated (optimistic case)", value: best != null ? f.s(best) : "does not reach 60 mph" },
    ];
    if (claim < tMinOpt) {
      add({
        id: "claims.zeroTo60",
        category: "claims",
        label: "Claimed 0–60 mph vs. traction limit",
        outcome: "violation",
        detail: `A ${f.s(claim)} 0–60 needs an average ${needG.toFixed(2)} g, but the driven tires can transmit at most ${f.g(launchAccelBound(opt))} (μ up to ${(opt.tireMu * opt.surfaceFactor).toFixed(2)}, ${inp.drivetrain}). Even with optimistic grip the minimum is ${f.s(tMinOpt)}.`,
        values,
        suggestion: "Check the claim, or specify the tires/surface (μ) and drivetrain that would support it.",
      });
    } else if (best == null || claim < best) {
      add({
        id: "claims.zeroTo60",
        category: "claims",
        label: "Claimed 0–60 mph vs. simulation",
        outcome: "caution",
        detail: `The claim is physically possible with grip (minimum ${f.s(tMinNom)} at nominal μ) but faster than the simulation even under optimistic inputs${best != null ? ` (${f.s(best)})` : ""}. It would need more power, grip or a better launch than modeled.`,
        values,
      });
    } else {
      add({ id: "claims.zeroTo60", category: "claims", label: "Claimed 0–60 mph vs. simulation", outcome: "pass", detail: `The claim is consistent with the simulated ${f.s(m.zeroTo60S!)} and its uncertainty range.`, values });
    }
  }
  if (c.claimedTopSpeedMs != null) {
    const claim = c.claimedTopSpeedMs;
    const vMaxOpt = maxSpeedByPower(opt);
    const values = [
      { label: "Claimed top speed", value: f.speed(claim) },
      { label: "Power-limited maximum (optimistic aero & losses)", value: f.speed(vMaxOpt) },
      { label: "Simulated top speed", value: m.topSpeedMs ? f.speed(m.topSpeedMs) : "beyond model range" },
    ];
    if (claim > vMaxOpt) {
      const needW = ((0.5 * inp.airDensity * cda * claim * claim + inp.rollingResistance * inp.massKg * G) * claim) / inp.drivetrainEfficiency;
      add({
        id: "claims.topSpeed",
        category: "claims",
        label: "Claimed top speed vs. power available",
        outcome: "violation",
        detail: `Holding ${f.speed(claim)} against drag (Cd·A ${cda.toFixed(2)} m²) and rolling resistance needs about ${f.power(needW)} at the engine; the configuration provides ${f.power(P * inp.powerFactor)}. Even with optimistic aero and losses the limit is ${f.speed(vMaxOpt)}.`,
        values,
        suggestion: "Check the claim, or provide measured aerodynamic data.",
      });
    } else if (m.topSpeedMs != null && claim > m.topSpeedMs) {
      add({ id: "claims.topSpeed", category: "claims", label: "Claimed top speed vs. simulation", outcome: "caution", detail: "The claim is within the power limit but above the simulated top speed (gearing or nominal aero would prevent it).", values });
    } else {
      add({ id: "claims.topSpeed", category: "claims", label: "Claimed top speed vs. simulation", outcome: "pass", detail: "The claim is consistent with the simulated top speed.", values });
    }
  }

  // --- Mechanical (only with explicitly supplied ratings) ----------------------------------------
  if (c.drivetrainTorqueLimitNm != null) {
    const lim = c.drivetrainTorqueLimitNm;
    add({
      id: "mechanical.driveline",
      category: "mechanical",
      label: "Drivetrain torque rating",
      outcome: T > lim ? "violation" : T > lim * 0.9 ? "caution" : "pass",
      detail:
        T > lim
          ? `Peak engine torque ${f.torque(T)} exceeds the stated drivetrain rating of ${f.torque(lim)} by ${((T / lim - 1) * 100).toFixed(0)}%.`
          : T > lim * 0.9
            ? `Peak engine torque is within 10% of the stated ${f.torque(lim)} rating — little margin.`
            : `Peak engine torque ${f.torque(T)} is within the stated ${f.torque(lim)} rating.`,
      suggestion: T > lim ? "Reduce torque or use a driveline rated for it." : undefined,
    });
  } else {
    const outputUp = scenario === "modified" && a.stock && (P > a.stock.inputs.curve.peakPowerW * 1.005 || T > a.stock.inputs.curve.peakTorqueNm * 1.005);
    if (outputUp) {
      const pUp = P / a.stock!.inputs.curve.peakPowerW - 1;
      const tUp = T / a.stock!.inputs.curve.peakTorqueNm - 1;
      add({
        id: "mechanical.driveline",
        category: "mechanical",
        label: "Component capacity",
        outcome: "caution",
        detail: `Output is raised (power ${f.pct(pUp)}, torque ${f.pct(tUp)} vs. stock) with no component ratings available. Engine internals, transmission, axles and cooling capacity are unverified.`,
        suggestion: "Add the drivetrain torque rating (Advanced Settings → Claims & component limits).",
      });
    } else {
      add({ id: "mechanical.driveline", category: "mechanical", label: "Component capacity", outcome: "not_assessed", detail: "No component ratings available; mechanical durability is not assessed (and not counted against feasibility)." });
    }
  }
  if (c.tireSpeedRatingMs != null) {
    const rating = c.tireSpeedRatingMs;
    const claimOver = c.claimedTopSpeedMs != null && c.claimedTopSpeedMs > rating;
    const topOver = m.topSpeedMs == null || m.topSpeedMs > rating;
    add({
      id: "mechanical.tireSpeed",
      category: "mechanical",
      label: "Tire speed rating",
      outcome: claimOver ? "violation" : topOver ? "caution" : "pass",
      detail: claimOver
        ? `The claimed top speed exceeds the stated tire speed rating of ${f.speed(rating)}.`
        : topOver
          ? `Theoretical top speed exceeds the stated tire rating of ${f.speed(rating)}; that speed is not usable on these tires.`
          : `Theoretical top speed is within the stated tire rating of ${f.speed(rating)}.`,
    });
  }

  // --- Model validity -----------------------------------------------------------------------------
  const ptw = P / inp.massKg;
  if (ptw > VALIDATED_POWER_TO_WEIGHT_WKG) {
    add({
      id: "model.ptw",
      category: "model",
      label: "Model validity range",
      outcome: "caution",
      detail: `Power-to-weight ${ptw.toFixed(0)} W/kg exceeds production hypercars (≈ 550–620 W/kg). The simplified model (constant μ, no aerodynamic load, no tire load sensitivity) has no validation basis here; treat results as indicative.`,
    });
  }

  // --- Classification ------------------------------------------------------------------------------
  const order = (x: ConstraintCheck) => CATEGORY_PRIORITY.indexOf(x.category);
  const violations = checks.filter((x) => x.outcome === "violation").sort((x, y) => order(x) - order(y));
  const cautions = checks.filter((x) => x.outcome === "caution").sort((x, y) => order(x) - order(y));
  let status: FeasibilityStatus;
  let primaryReason: string;
  if (violations.length) {
    status = "non_feasible";
    primaryReason = violations[0].detail;
  } else if (estimatedCore.length >= 3) {
    status = "insufficient_data";
    primaryReason = `Too many core inputs are assumptions (${estimatedCore.map((k) => SPEC_LABEL[k].toLowerCase()).join(", ")}) to judge feasibility meaningfully.`;
  } else if (cautions.length) {
    status = "questionable";
    primaryReason = cautions[0].detail;
  } else {
    status = "feasible";
    primaryReason = "Every evaluated constraint is satisfied within the stated assumptions. This is not a certification of real-world safety or performance.";
  }

  const missing: string[] = [];
  for (const k of ["curbMassKg", "peakTorqueNm", "gearRatios", "finalDrive", "dragCoefficient", "tireMu"] as SpecKey[]) {
    if (p(k) === "estimated") missing.push(`${SPEC_LABEL[k]} (using an AutoDyn estimate)`);
  }
  if (c.drivetrainTorqueLimitNm == null) missing.push("Drivetrain torque rating (mechanical limits not assessed)");
  if (c.tireSpeedRatingMs == null && (m.topSpeedMs == null || m.topSpeedMs > STREET_TIRE_MAX_MS * 0.8)) missing.push("Tire speed rating");

  const keyInputs: SpecKey[] = ["peakPowerKw", "peakTorqueNm", "curbMassKg", "drivetrain", "tireMu", "dragCoefficient", "frontalAreaM2", "drivetrainEfficiency"];
  const inputValue = (k: SpecKey): string => {
    switch (k) {
      case "peakPowerKw":
        return f.power(P);
      case "peakTorqueNm":
        return f.torque(T);
      case "curbMassKg":
        return f.mass(inp.curbMassKg);
      case "drivetrain":
        return inp.drivetrain;
      case "frontalAreaM2":
        return `${inp.frontalAreaM2.toFixed(2)} m²`;
      case "drivetrainEfficiency":
        return `${(inp.drivetrainEfficiency * 100).toFixed(0)}%`;
      case "tireMu":
        return `μ ${inp.tireMu.toFixed(2)}`;
      case "dragCoefficient":
        return inp.dragCoefficient.toFixed(3);
      default:
        return "";
    }
  };

  return {
    scenario,
    status,
    headline: FEASIBILITY_HEADLINE[status],
    primaryReason,
    checks,
    inputs: keyInputs.map((k) => ({ label: SPEC_LABEL[k], value: inputValue(k), provenance: p(k) })),
    assumptions: r.estimates.filter((e) => e.key !== "launchRpm").map((e) => `${SPEC_LABEL[e.key as SpecKey]}: ${e.reason}`),
    missing,
    suggestions: Array.from(new Set(checks.filter((x) => x.outcome !== "pass" && x.suggestion).map((x) => x.suggestion!))),
    engineVersion: FEASIBILITY_ENGINE_VERSION,
  };
}

/** Assessment straight from a configuration, for states where no full analysis exists yet. */
export function assessConfig(config: AnalysisConfig, analysis?: { stock: ScenarioResult; modified: ScenarioResult | null } | null): Record<ScenarioId, ScenarioAssessment | null> {
  const out: Record<ScenarioId, ScenarioAssessment | null> = { stock: null, modified: null };
  if (!config.stock) return out;
  const validation = validateConfig(config);
  for (const scenario of ["stock", "modified"] as ScenarioId[]) {
    if (scenario === "modified" && !config.modified) continue;
    const errors = validation.issues.filter((i) => i.severity === "error" && (i.scenario === scenario || i.scenario === "conditions"));
    const required = errors.filter((i) => i.key === "peakPowerKw" || i.key === "curbMassKg");
    const values = effectiveValues(config, scenario)!;
    const resolved = resolveInputs(values, config.conditions, config.stock.identity);
    if (!resolved.ok && required.length === errors.length) {
      out[scenario] = {
        scenario,
        status: "insufficient_data",
        headline: FEASIBILITY_HEADLINE.insufficient_data,
        primaryReason: `The simulation cannot run without ${resolved.missing.map((k) => SPEC_LABEL[k].toLowerCase()).join(" and ")}.`,
        checks: [],
        inputs: [],
        assumptions: [],
        missing: resolved.missing.map((k) => SPEC_LABEL[k]),
        suggestions: resolved.missing.map((k) => `Provide ${SPEC_LABEL[k].toLowerCase()}.`),
        engineVersion: FEASIBILITY_ENGINE_VERSION,
      };
      continue;
    }
    if (errors.length) {
      out[scenario] = { scenario, status: "input_error", issues: errors };
      continue;
    }
    const result = analysis?.[scenario];
    if (!result) continue;
    out[scenario] = assessScenario({
      scenario,
      values,
      identity: config.stock.identity,
      constraints: effectiveConstraints(config, scenario),
      rollout: config.conditions.rollout,
      result,
      stock: scenario === "modified" ? analysis?.stock : null,
    });
  }
  return out;
}
