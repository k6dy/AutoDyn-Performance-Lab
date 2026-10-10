// Physical bounds derived from the same force model the simulator uses. Each is a genuine bound
// under its stated assumptions, so a claim beyond it conflicts with the model's physics rather
// than with an arbitrary threshold.

import type { ResolvedInputs } from "@/lib/physics/resolve";
import { engineForce, resistance, tractionLimit } from "@/lib/physics/simulate";
import { G, M_PER_FT, mphToMs } from "@/lib/units";

/** Wheel/driveline inertia that remains even when the engine is decoupled (see simulate.ts). */
const MIN_INERTIA_FACTOR = 1.04;

/**
 * Upper bound on launch acceleration (m/s²): maximum tractive force with longitudinal load
 * transfer at standstill, minus rolling resistance, over the minimum effective mass. Drag is zero
 * at launch and only reduces acceleration later, so no run can average more than this.
 */
export function launchAccelBound(inp: ResolvedInputs): number {
  const rolling = resistance(inp, 0);
  const force = tractionLimit(inp, rolling) - rolling;
  return Math.max(force, 0) / (inp.massKg * MIN_INERTIA_FACTOR);
}

/** Lower bound on 0–60 mph time (s) implied by the traction bound (optionally with 1-ft rollout). */
export function minZeroTo60(inp: ResolvedInputs, rollout: boolean): number {
  const a = launchAccelBound(inp);
  if (a <= 0) return Infinity;
  const t = mphToMs(60) / a;
  return rollout ? Math.max(t - Math.sqrt((2 * M_PER_FT) / a), 0) : t;
}

/**
 * Highest steady speed (m/s) the rated power can sustain against drag and rolling resistance,
 * independent of gearing (an upper bound on any top speed): P·η = (½ρCdA·v² + Crr·m·g)·v.
 */
export function maxSpeedByPower(inp: ResolvedInputs): number {
  const wheelPower = inp.curve.peakPowerW * inp.powerFactor * inp.drivetrainEfficiency;
  const demand = (v: number) => resistance(inp, v) * v;
  let lo = 0;
  let hi = 400;
  if (demand(hi) < wheelPower) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (demand(mid) < wheelPower) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Ratio of first-gear drive force at launch to available tire force (>1 means wheelspin). */
export function launchForceRatio(inp: ResolvedInputs): number {
  const f = engineForce(inp, 0, 0.1).force;
  const cap = tractionLimit(inp, resistance(inp, 0));
  return cap > 0 ? f / cap : Infinity;
}

/** Share of vehicle weight on the driven wheels at launch, including load transfer. */
export function drivenAxleShare(inp: ResolvedInputs): number {
  const a = launchAccelBound(inp);
  const shift = (inp.cgHeightRatio * a) / G;
  if (inp.drivetrain === "RWD") return Math.min(1, 1 - inp.frontWeightFraction + shift);
  if (inp.drivetrain === "FWD") return Math.max(0, inp.frontWeightFraction - shift);
  return 1;
}
