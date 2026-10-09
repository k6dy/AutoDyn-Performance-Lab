// Documented estimation rules. Every function here produces an *estimate*; callers must
// label results with provenance "estimated" and keep the returned reason.

import type { Drivetrain, Powertrain, TransmissionType } from "@/lib/domain/types";

export type Estimate = { value: number; reason: string };

function bodyClass(body?: string | null) {
  const b = (body ?? "").toLowerCase();
  if (/pickup|truck|cab/.test(b)) return "truck";
  if (/suv|sport utility|crossover/.test(b)) return "suv";
  if (/van|minivan/.test(b)) return "van";
  if (/wagon/.test(b)) return "wagon";
  if (/hatch/.test(b)) return "hatch";
  if (/convertible|coupe|roadster/.test(b)) return "coupe";
  if (/sedan/.test(b)) return "sedan";
  return "unknown";
}

const CD_BY_BODY: Record<string, number> = {
  coupe: 0.31, sedan: 0.29, hatch: 0.32, wagon: 0.31, suv: 0.35, van: 0.33, truck: 0.42, unknown: 0.32,
};
const AREA_BY_BODY: Record<string, number> = {
  coupe: 2.0, sedan: 2.2, hatch: 2.15, wagon: 2.25, suv: 2.65, van: 2.9, truck: 3.1, unknown: 2.3,
};
const RADIUS_BY_BODY: Record<string, number> = {
  coupe: 0.325, sedan: 0.32, hatch: 0.31, wagon: 0.325, suv: 0.36, van: 0.35, truck: 0.40, unknown: 0.33,
};

export function estimateDragCoefficient(body?: string | null): Estimate {
  const c = bodyClass(body);
  return { value: CD_BY_BODY[c], reason: `Typical Cd for a ${c === "unknown" ? "passenger vehicle" : c} body` };
}

export function estimateFrontalArea(widthM?: number | null, heightM?: number | null, body?: string | null): Estimate {
  if (widthM && heightM && widthM > 1 && widthM < 3 && heightM > 0.9 && heightM < 3.5) {
    return {
      value: Number((0.84 * widthM * heightM).toFixed(2)),
      reason: "0.84 × body width × height (published dimensions)",
    };
  }
  const c = bodyClass(body);
  return { value: AREA_BY_BODY[c], reason: `Typical frontal area for a ${c === "unknown" ? "passenger vehicle" : c} body` };
}

export function estimateTireRadius(body?: string | null): Estimate {
  const c = bodyClass(body);
  return { value: RADIUS_BY_BODY[c], reason: `Typical tire radius for a ${c === "unknown" ? "passenger vehicle" : c}` };
}

export function estimateCgRatio(body?: string | null): Estimate {
  const c = bodyClass(body);
  const tall = c === "suv" || c === "truck" || c === "van";
  return { value: tall ? 0.25 : 0.19, reason: tall ? "Typical for a tall body" : "Typical for a passenger car" };
}

export function estimateEfficiency(drivetrain: Drivetrain | null, powertrain: Powertrain | null): Estimate {
  if (powertrain === "ev") return { value: 0.92, reason: "Single-reduction electric drive" };
  switch (drivetrain) {
    case "FWD": return { value: 0.88, reason: "Transverse FWD layout (≈12% loss)" };
    case "RWD": return { value: 0.86, reason: "Longitudinal RWD layout (≈14% loss)" };
    case "AWD": return { value: 0.82, reason: "AWD layout (≈18% loss)" };
    case "4WD": return { value: 0.8, reason: "4WD transfer case layout (≈20% loss)" };
    default: return { value: 0.85, reason: "Generic drivetrain loss (≈15%)" };
  }
}

export function estimateFrontWeight(drivetrain: Drivetrain | null, powertrain: Powertrain | null): Estimate {
  if (powertrain === "ev") return { value: 0.48, reason: "Floor-mounted battery layout" };
  switch (drivetrain) {
    case "FWD": return { value: 0.61, reason: "Front-engine FWD" };
    case "RWD": return { value: 0.53, reason: "Front-engine RWD" };
    case "AWD": return { value: 0.57, reason: "Front-engine AWD" };
    case "4WD": return { value: 0.56, reason: "Front-engine 4WD" };
    default: return { value: 0.57, reason: "Front-engine layout" };
  }
}

export function estimateShiftTime(t: TransmissionType | null): Estimate {
  switch (t) {
    case "manual": return { value: 0.3, reason: "Manual shift with clutch" };
    case "dct": return { value: 0.08, reason: "Dual-clutch shift" };
    case "cvt":
    case "direct": return { value: 0, reason: "No discrete shifts" };
    default: return { value: 0.12, reason: "Modern torque-converter automatic (partial torque fill)" };
  }
}

export function estimateRedline(powertrain: Powertrain | null, fuel: "gas" | "diesel" | null, peakPowerRpm: number | null): Estimate {
  if (powertrain === "ev") return { value: 16000, reason: "Typical traction-motor maximum speed" };
  if (peakPowerRpm) return { value: Math.round(peakPowerRpm + 500), reason: "500 rpm above power peak" };
  if (fuel === "diesel") return { value: 4600, reason: "Typical diesel redline" };
  return { value: 6500, reason: "Typical gasoline redline" };
}

/** Typical first/top gear ratios by transmission type and gear count; intermediate gears are geometric. */
export function estimateGearRatios(t: TransmissionType | null, count: number): Estimate & { ratios: number[] } {
  if (t === "direct" || count <= 1) return { value: 1, ratios: [1], reason: "Single fixed ratio" };
  if (t === "cvt") return { value: 2, ratios: [2.6, 0.4], reason: "Typical CVT ratio span (6.5:1)" };
  const manualLike = t === "manual" || t === "dct";
  const firstByCount: Record<number, number> = manualLike
    ? { 4: 3.3, 5: 3.5, 6: 3.6, 7: 3.9, 8: 4.0 }
    : { 4: 2.8, 5: 3.5, 6: 4.1, 7: 4.4, 8: 4.7, 9: 4.7, 10: 4.7 };
  const topByCount: Record<number, number> = manualLike
    ? { 4: 0.9, 5: 0.8, 6: 0.75, 7: 0.7, 8: 0.65 }
    : { 4: 0.7, 5: 0.8, 6: 0.69, 7: 0.72, 8: 0.67, 9: 0.6, 10: 0.64 };
  const n = Math.min(Math.max(Math.round(count), 2), 10);
  const first = firstByCount[n] ?? 4.0;
  const top = topByCount[n] ?? 0.7;
  const step = Math.pow(top / first, 1 / (n - 1));
  const ratios = Array.from({ length: n }, (_, i) => Number((first * Math.pow(step, i)).toFixed(3)));
  return { value: n, ratios, reason: `Typical ${n}-speed ${manualLike ? "manual/DCT" : "automatic"} spread, geometric steps` };
}

/** Final drive sized so first gear reaches a typical speed at redline. */
export function estimateFinalDrive(
  firstGear: number,
  redlineRpm: number,
  tireRadiusM: number,
  t: TransmissionType | null,
  powertrain: Powertrain | null,
): Estimate {
  if (powertrain === "ev") {
    // Top speed at max motor speed ≈ 60 m/s (≈135 mph), typical for road EVs.
    const ratio = (redlineRpm * 2 * Math.PI * tireRadiusM) / 60 / 60;
    return { value: Number(ratio.toFixed(2)), reason: "Sized for ≈135 mph at max motor speed" };
  }
  const targetFirstGearMs = t === "manual" ? 19 : t === "cvt" ? 20 : 17;
  const ratio = (redlineRpm * 2 * Math.PI * tireRadiusM) / 60 / (firstGear * targetFirstGearMs);
  return {
    value: Number(Math.min(Math.max(ratio, 2), 6).toFixed(2)),
    reason: `Sized so first gear reaches ≈${Math.round(targetFirstGearMs * 2.237)} mph at redline`,
  };
}

export function parseTransmission(text?: string | null): { type: TransmissionType | null; gears: number | null } {
  const t = (text ?? "").toLowerCase();
  if (!t) return { type: null, gears: null };
  const gearsMatch = t.match(/(\d+)-speed/);
  const gears = gearsMatch ? Number(gearsMatch[1]) : null;
  if (t.includes("direct drive") || (gears === 1 && t.includes("automatic"))) return { type: "direct", gears: 1 };
  if (t.includes("continuously variable") || t.includes("cvt")) return { type: "cvt", gears: null };
  if (t.includes("automated manual") || t.includes("dual-clutch") || t.includes("dct")) return { type: "dct", gears };
  if (t.includes("manual")) return { type: "manual", gears };
  if (t.includes("automatic")) return { type: "automatic", gears };
  return { type: null, gears };
}

export function parseDrivetrain(text?: string | null): Drivetrain | null {
  const d = (text ?? "").toLowerCase();
  if (!d) return null;
  if (d.includes("front")) return "FWD";
  if (d.includes("rear")) return "RWD";
  if (d.includes("all")) return "AWD";
  if (d.includes("four") || d.includes("4wd") || d.includes("4x4")) return "4WD";
  if (d === "fwd") return "FWD";
  if (d === "rwd") return "RWD";
  if (d === "awd") return "AWD";
  return null;
}
