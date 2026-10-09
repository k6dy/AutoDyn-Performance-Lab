// Synthesized full-load torque curves. Peak values alone are not a power curve, so the shape
// below is an explicit, documented approximation that preserves the stated peaks exactly:
//   max(T) = peak torque (at the torque-peak speed) and max(T·ω) = peak power (at the power-peak speed).

import { rpmToRadS } from "@/lib/units";

export type CurveShape = "plateau" | "linear" | "electric";

export type CurveParams = {
  peakPowerW: number;
  peakTorqueNm: number;
  peakPowerRpm: number;
  peakTorqueRpm: number;
  redlineRpm: number;
  idleRpm: number;
  shape: CurveShape;
};

/** Full-load torque (N·m) at a given engine/motor speed. */
export function torqueAt(p: CurveParams, rpm: number): number {
  if (rpm > p.redlineRpm + 1) return 0;
  const omega = rpmToRadS(Math.max(rpm, 1));
  const powerCap = p.peakPowerW / omega;

  if (p.shape === "electric") {
    return Math.min(p.peakTorqueNm, powerCap);
  }

  const r = Math.max(rpm, p.idleRpm);
  if (r <= p.peakTorqueRpm) {
    const span = p.peakTorqueRpm - p.idleRpm;
    const x = span > 0 ? (r - p.idleRpm) / span : 1;
    const f0 = p.shape === "plateau" ? 0.5 : 0.68;
    const ease = 1 - (1 - x) * (1 - x);
    return Math.min(p.peakTorqueNm * (f0 + (1 - f0) * ease), p.peakPowerW / rpmToRadS(r));
  }

  if (r <= p.peakPowerRpm) {
    if (p.shape === "plateau") return Math.min(p.peakTorqueNm, p.peakPowerW / rpmToRadS(r));
    const torqueAtPowerPeak = p.peakPowerW / rpmToRadS(p.peakPowerRpm);
    const span = p.peakPowerRpm - p.peakTorqueRpm;
    const x = span > 0 ? (r - p.peakTorqueRpm) / span : 1;
    const linear = p.peakTorqueNm + (torqueAtPowerPeak - p.peakTorqueNm) * x;
    return Math.min(linear, p.peakPowerW / rpmToRadS(r));
  }

  // Past the power peak: power falls linearly to a fraction of peak at redline.
  const fade = p.shape === "plateau" ? 0.88 : 0.92;
  const span = p.redlineRpm - p.peakPowerRpm;
  const x = span > 0 ? (r - p.peakPowerRpm) / span : 0;
  const power = p.peakPowerW * (1 - (1 - fade) * Math.min(x, 1));
  return power / rpmToRadS(r);
}

export type CurvePoint = { rpm: number; torqueNm: number; powerKw: number };

export function sampleCurve(p: CurveParams, points = 60): CurvePoint[] {
  const start = p.shape === "electric" ? 0 : p.idleRpm;
  const out: CurvePoint[] = [];
  for (let i = 0; i <= points; i++) {
    const rpm = Math.round(start + ((p.redlineRpm - start) * i) / points);
    const t = torqueAt(p, rpm);
    out.push({ rpm, torqueNm: t, powerKw: (t * rpmToRadS(rpm)) / 1000 });
  }
  return out;
}
