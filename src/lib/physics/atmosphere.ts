import type { Aspiration } from "@/lib/domain/types";

const P0 = 101325; // Pa, sea-level standard pressure
const R_DRY = 287.05; // J/(kg·K)
const T_REF_K = 298.15; // 25 °C — reference at which rated power is assumed

/** Barometric pressure (Pa) from elevation using the ISA troposphere model. */
export function pressureAtElevation(elevationM: number) {
  return P0 * Math.pow(1 - 2.25577e-5 * elevationM, 5.25588);
}

/** Dry-air density (kg/m³). Humidity is not modeled. */
export function airDensity(tempC: number, elevationM: number) {
  return pressureAtElevation(elevationM) / (R_DRY * (tempC + 273.15));
}

/**
 * Engine output correction relative to the rated reference (25 °C, sea level), following the
 * SAE J1349 form (p/p_ref)·√(T_ref/T). Forced-induction engines are assumed to recover 75% of the
 * deficit (boost control); electric motors are assumed unaffected.
 */
export function powerCorrectionFactor(tempC: number, elevationM: number, aspiration: Aspiration) {
  if (aspiration === "electric") return 1;
  const na = (pressureAtElevation(elevationM) / P0) * Math.sqrt(T_REF_K / (tempC + 273.15));
  if (aspiration === "forced") return na >= 1 ? 1 + (na - 1) * 0.25 : 1 - (1 - na) * 0.25;
  return na;
}
