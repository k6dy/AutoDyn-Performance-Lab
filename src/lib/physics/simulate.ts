// Deterministic longitudinal full-throttle simulation (point-mass with axle load transfer).
//
// Model summary (all SI):
//  • Wheel force  F = T_engine(rpm) · gear · finalDrive · η / r_tire, capped by tire traction.
//  • Traction     F ≤ μ·N_driven, with static weight split plus longitudinal load transfer (h/L).
//                 AWD/4WD assume an ideal torque split (all four tires usable).
//  • Resistance   aerodynamic drag ½ρCdAv² + rolling resistance Crr·m·g (level road, no wind).
//  • Inertia      effective mass m·(1.04 + k·(overall ratio)²) for rotating parts.
//  • Shifting     optimal-force upshifts (or at redline) with zero drive force during shift time.
//  • Launch       clutch slip at launch rpm; torque-converter multiplication for automatics/CVTs.
//  • Integration  semi-implicit Euler, fixed time step.

import { torqueAt } from "@/lib/physics/curve";
import type { ResolvedInputs } from "@/lib/physics/resolve";
import { G, mphToMs, kphToMs, QUARTER_MILE_M, M_PER_FT, radSToRpm, rpmToRadS } from "@/lib/units";

export type LimitState = "traction" | "power" | "shift" | "limiter";

export type Sample = {
  t: number;
  v: number; // m/s
  a: number; // m/s²
  x: number; // m
  gear: number; // 1-based
  rpm: number;
  limit: LimitState;
  wheelPowerKw: number;
};

export type RunMetrics = {
  zeroTo60S: number | null;
  zeroTo100KphS: number | null;
  zeroTo100MphS: number | null;
  quarterMileS: number | null;
  quarterMileTrapMs: number | null;
  fiftyToSeventyS: number | null;
  topSpeedMs: number | null;
  topSpeedLimitedBy: "drag" | "redline" | null;
  peakAccelG: number;
  tractionShareTo60: number | null;
  shiftsTo60: number;
};

export type RunResult = { metrics: RunMetrics; samples: Sample[] };

type Options = { dt?: number; sampleEvery?: number; collectSamples?: boolean; rollout?: boolean; maxTimeS?: number; topSpeed?: boolean };

const STALL_TORQUE_RATIO = 2.0;
const COUPLING_SPEED_RATIO = 0.85;

export function inertiaFactor(inp: ResolvedInputs, overall: number) {
  const k = inp.powertrain === "ev" ? 0.0008 : 0.0015;
  return 1.04 + k * overall * overall;
}

function overallRatio(inp: ResolvedInputs, gearIdx: number, v: number) {
  if (inp.transmission !== "cvt") return inp.gearRatios[gearIdx] * inp.finalDrive;
  // CVT: hold the engine at the power peak within the available ratio span.
  const low = inp.gearRatios[0] * inp.finalDrive;
  const high = inp.gearRatios[inp.gearRatios.length - 1] * inp.finalDrive;
  if (v <= 0.1) return low;
  const target = (rpmToRadS(inp.curve.peakPowerRpm) * inp.tireRadiusM) / v;
  return Math.min(low, Math.max(high, target));
}

/** Untractioned wheel force in a gear at speed v, plus the engine speed and power used. */
export function engineForce(inp: ResolvedInputs, gearIdx: number, v: number) {
  const overall = overallRatio(inp, gearIdx, v);
  const wheelOmega = v / inp.tireRadiusM;
  const coupledRpm = radSToRpm(wheelOmega * overall);
  let rpm = coupledRpm;
  let multiplier = 1;
  let slipping = false;

  if (inp.powertrain !== "ev" && coupledRpm < inp.launchRpm) {
    rpm = inp.launchRpm; // clutch slip or torque-converter slip
    slipping = true;
    if (inp.torqueConverter) {
      const sr = coupledRpm / inp.launchRpm;
      multiplier = 1 + (STALL_TORQUE_RATIO - 1) * Math.max(0, 1 - sr / COUPLING_SPEED_RATIO);
    }
  }
  if (rpm > inp.curve.redlineRpm) return { force: 0, rpm: coupledRpm, overall, overRev: true, slipping };
  const torque = torqueAt(inp.curve, rpm) * inp.powerFactor;
  const force = (torque * multiplier * overall * inp.drivetrainEfficiency) / inp.tireRadiusM;
  return { force, rpm, overall, overRev: false, slipping };
}

export function tractionLimit(inp: ResolvedInputs, resist: number) {
  const mu = inp.tireMu * inp.surfaceFactor;
  const weight = inp.massKg * G;
  const hl = inp.cgHeightRatio;
  switch (inp.drivetrain) {
    case "RWD":
      return (mu * (weight * (1 - inp.frontWeightFraction) - resist * hl)) / Math.max(1 - mu * hl, 0.2);
    case "FWD":
      return (mu * (weight * inp.frontWeightFraction + resist * hl)) / (1 + mu * hl);
    default:
      return mu * weight;
  }
}

export function resistance(inp: ResolvedInputs, v: number) {
  return 0.5 * inp.airDensity * inp.dragCoefficient * inp.frontalAreaM2 * v * v + inp.rollingResistance * inp.massKg * G;
}

function bestGear(inp: ResolvedInputs, v: number) {
  let best = 0;
  let bestForce = -1;
  for (let i = 0; i < inp.gearRatios.length; i++) {
    const f = engineForce(inp, i, v);
    if (!f.overRev && f.force > bestForce) {
      bestForce = f.force;
      best = i;
    }
  }
  return { gear: best, force: Math.max(bestForce, 0) };
}

/** Steady-state top speed: highest speed where available force still exceeds resistance. */
export function topSpeed(inp: ResolvedInputs): { speedMs: number | null; limitedBy: "drag" | "redline" | null } {
  const step = 0.1;
  let lastOk = 0;
  for (let v = 1; v <= 160; v += step) {
    const { force } = bestGear(inp, v);
    const usable = Math.min(force, tractionLimit(inp, resistance(inp, v)));
    if (usable < resistance(inp, v)) {
      // Distinguish running out of revs (force collapses to zero) from drag balance.
      const prev = bestGear(inp, Math.max(v - step, 0.5)).force;
      const limitedBy = force <= 0 && prev > resistance(inp, v - step) ? "redline" : "drag";
      return { speedMs: lastOk > 0 ? lastOk : null, limitedBy };
    }
    lastOk = v;
  }
  return { speedMs: null, limitedBy: null };
}

export function simulateRun(inp: ResolvedInputs, opts: Options = {}): RunResult {
  const dt = opts.dt ?? 0.004;
  const sampleEvery = opts.sampleEvery ?? 0.05;
  const collect = opts.collectSamples ?? true;
  const maxTime = opts.maxTimeS ?? 60;

  const v60 = mphToMs(60);
  const v100k = kphToMs(100);
  const v100m = mphToMs(100);
  const v50 = mphToMs(50);
  const v70 = mphToMs(70);

  let t = 0;
  let v = 0;
  let x = 0;
  let gear = 0;
  let shiftTimer = 0;
  let pendingGear = -1;
  let shifts = 0;
  let nextSample = 0;
  let peakA = 0;
  let tractionTime = 0;
  let rolloutTime: number | null = opts.rollout ? null : 0;

  const m: RunMetrics = {
    zeroTo60S: null,
    zeroTo100KphS: null,
    zeroTo100MphS: null,
    quarterMileS: null,
    quarterMileTrapMs: null,
    fiftyToSeventyS: null,
    topSpeedMs: null,
    topSpeedLimitedBy: null,
    peakAccelG: 0,
    tractionShareTo60: null,
    shiftsTo60: 0,
  };
  let t50: number | null = null;
  const samples: Sample[] = [];

  while (t < maxTime) {
    // Gear selection (no CVT/direct shifts).
    if (shiftTimer <= 0 && pendingGear >= 0) {
      gear = pendingGear;
      pendingGear = -1;
    }
    if (shiftTimer <= 0 && inp.transmission !== "cvt" && gear < inp.gearRatios.length - 1) {
      const cur = engineForce(inp, gear, v);
      const next = engineForce(inp, gear + 1, v);
      const nearRedline = cur.rpm >= inp.curve.redlineRpm * 0.995 || cur.overRev;
      if (nearRedline || (next.force > cur.force && v > 1)) {
        pendingGear = gear + 1;
        shiftTimer = inp.shiftTimeS;
        shifts += 1;
        if (inp.shiftTimeS <= 0) {
          gear = pendingGear;
          pendingGear = -1;
        }
      }
    }

    const shifting = shiftTimer > 0;
    const ef = engineForce(inp, gear, v);
    const resist = resistance(inp, v);
    const cap = tractionLimit(inp, resist);
    let drive = shifting ? 0 : ef.force;
    let limit: LimitState = shifting ? "shift" : ef.overRev ? "limiter" : "power";
    if (drive > cap) {
      drive = cap;
      limit = "traction";
    }

    // Engine/motor inertia is only reflected at the wheels when it is coupled and the tires are
    // not at their limit; otherwise surplus engine torque spins it up and wheels/driveline remain.
    const coupled = !shifting && !ef.slipping && limit !== "traction";
    const mEff = inp.massKg * (coupled ? inertiaFactor(inp, ef.overall) : 1.04);
    let a = (drive - resist) / mEff;
    if (v <= 0 && a < 0) a = 0;
    const vStep = v;
    v = Math.max(0, v + a * dt);
    x += v * dt;
    t += dt;
    if (shiftTimer > 0) shiftTimer -= dt;

    peakA = Math.max(peakA, a);
    if (m.zeroTo60S === null && limit === "traction") tractionTime += dt;
    if (rolloutTime === null && x >= M_PER_FT) rolloutTime = t;

    if (m.zeroTo60S === null && v >= v60) {
      m.zeroTo60S = t - (rolloutTime ?? 0);
      m.shiftsTo60 = shifts - (pendingGear >= 0 ? 1 : 0);
      m.tractionShareTo60 = tractionTime / t;
    }
    if (m.zeroTo100KphS === null && v >= v100k) m.zeroTo100KphS = t;
    if (m.zeroTo100MphS === null && v >= v100m) m.zeroTo100MphS = t;
    if (t50 === null && v >= v50) t50 = t;
    if (m.fiftyToSeventyS === null && t50 !== null && v >= v70) m.fiftyToSeventyS = t - t50;
    if (m.quarterMileS === null && x >= QUARTER_MILE_M) {
      m.quarterMileS = t;
      m.quarterMileTrapMs = v;
    }

    if (collect && t >= nextSample) {
      samples.push({
        t,
        v,
        a,
        x,
        gear: gear + 1,
        rpm: Math.round(ef.rpm),
        limit,
        wheelPowerKw: (drive * vStep) / 1000,
      });
      nextSample += sampleEvery;
    }

    const done = m.quarterMileS !== null && (m.zeroTo100MphS !== null || t > 30);
    if (done) break;
    if (t > 5 && !shifting && a < 0.01) break; // reached terminal speed
  }

  if (opts.topSpeed !== false) {
    const top = topSpeed(inp);
    m.topSpeedMs = top.speedMs;
    m.topSpeedLimitedBy = top.limitedBy;
  }
  m.peakAccelG = peakA / G;

  return { metrics: m, samples };
}
