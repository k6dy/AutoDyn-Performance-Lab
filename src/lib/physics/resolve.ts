// Converts a (possibly incomplete) specification into fully-specified simulation inputs.
// Every value filled here is recorded in `estimates` with its reason so the UI and reports can
// label it. Peak power and curb mass are never estimated.

import { SURFACE_OPTIONS } from "@/lib/domain/fields";
import type {
  Aspiration,
  Conditions,
  Drivetrain,
  Powertrain,
  SpecKey,
  SpecValues,
  TransmissionType,
  VehicleIdentity,
} from "@/lib/domain/types";
import { airDensity, powerCorrectionFactor } from "@/lib/physics/atmosphere";
import type { CurveParams } from "@/lib/physics/curve";
import {
  estimateCgRatio,
  estimateEfficiency,
  estimateFinalDrive,
  estimateFrontWeight,
  estimateGearRatios,
  estimateRedline,
  estimateShiftTime,
  estimateTireRadius,
  estimateDragCoefficient,
  estimateFrontalArea,
} from "@/lib/physics/estimates";
import { radSToRpm, rpmToRadS } from "@/lib/units";

export type ResolvedInputs = {
  powertrain: Powertrain;
  aspiration: Aspiration;
  drivetrain: Drivetrain;
  transmission: TransmissionType;
  curve: CurveParams;
  gearRatios: number[];
  finalDrive: number;
  shiftTimeS: number;
  launchRpm: number;
  torqueConverter: boolean;
  curbMassKg: number;
  payloadKg: number;
  massKg: number;
  tireRadiusM: number;
  dragCoefficient: number;
  frontalAreaM2: number;
  drivetrainEfficiency: number;
  rollingResistance: number;
  frontWeightFraction: number;
  cgHeightRatio: number;
  tireMu: number;
  surfaceFactor: number;
  airDensity: number;
  powerFactor: number;
};

export type EstimateNote = { key: SpecKey | "launchRpm"; value: number | string | number[]; reason: string };

export type ResolveResult =
  | { ok: true; inputs: ResolvedInputs; estimates: EstimateNote[] }
  | { ok: false; missing: SpecKey[] };

type IdentityHints = Pick<VehicleIdentity, "bodyStyle" | "fuel">;

export function resolveInputs(values: SpecValues, conditions: Conditions, hints: IdentityHints = {}): ResolveResult {
  const missing: SpecKey[] = [];
  if (values.peakPowerKw.value == null) missing.push("peakPowerKw");
  if (values.curbMassKg.value == null) missing.push("curbMassKg");
  if (missing.length) return { ok: false, missing };

  const estimates: EstimateNote[] = [];
  function pick<T extends number | string | number[]>(key: SpecKey, given: T | null, est: () => { value: T; reason: string }): T {
    if (given !== null && given !== undefined) {
      if (values[key].provenance === "estimated") {
        estimates.push({ key, value: given, reason: values[key].note ?? values[key].source ?? "Estimated" });
      }
      return given;
    }
    const e = est();
    estimates.push({ key, value: e.value, reason: e.reason });
    return e.value;
  }

  const powertrain = pick<Powertrain>("powertrain", values.powertrain.value, () => ({ value: "ice", reason: "Assumed combustion engine" }));
  const isEv = powertrain === "ev";
  const aspiration = isEv
    ? "electric"
    : pick<Aspiration>("aspiration", values.aspiration.value === "electric" ? null : values.aspiration.value, () => ({
        value: "na",
        reason: "Assumed naturally aspirated",
      }));
  const drivetrain = pick<Drivetrain>("drivetrain", values.drivetrain.value, () => ({ value: "RWD", reason: "Assumed rear-wheel drive" }));
  const transmission: TransmissionType = isEv
    ? "direct"
    : pick<TransmissionType>("transmission", values.transmission.value === "direct" ? null : values.transmission.value, () => ({
        value: "automatic",
        reason: "Assumed torque-converter automatic",
      }));

  const peakPowerW = values.peakPowerKw.value! * 1000;
  const fuel = hints.fuel === "diesel" ? "diesel" : "gas";

  // --- Engine / motor speed envelope -------------------------------------------------------
  let redlineRpm = pick("redlineRpm", values.redlineRpm.value, () =>
    estimateRedline(powertrain, isEv ? null : fuel, values.peakPowerRpm.value),
  );

  let peakTorqueNm: number;
  let peakPowerRpm: number;
  let peakTorqueRpm: number;

  if (isEv) {
    peakTorqueNm = pick("peakTorqueNm", values.peakTorqueNm.value, () => ({
      value: Math.round(peakPowerW / rpmToRadS(5000)),
      reason: "Assumed 5,000 rpm base motor speed (low confidence)",
    }));
    // Base speed follows from torque and power; it is derived, not assumed.
    peakPowerRpm = Math.min(radSToRpm(peakPowerW / peakTorqueNm), redlineRpm);
    peakTorqueRpm = 0;
  } else {
    const givenPr = values.peakPowerRpm.value;
    peakTorqueNm = pick("peakTorqueNm", values.peakTorqueNm.value, () => {
      const prGuess = givenPr ?? redlineRpm - 500;
      return {
        value: Math.round((peakPowerW / rpmToRadS(prGuess)) * 1.15),
        reason: "Estimated from peak power assuming torque 15% above its value at the power peak (low confidence)",
      };
    });
    const rpmNeeded = radSToRpm(peakPowerW / peakTorqueNm);
    peakPowerRpm = pick("peakPowerRpm", givenPr, () => {
      const base = redlineRpm - (fuel === "diesel" ? 400 : 500);
      return base >= rpmNeeded
        ? { value: Math.round(base), reason: "Assumed 500 rpm below redline" }
        : { value: Math.round(rpmNeeded), reason: "Lowest speed at which the stated torque can produce peak power" };
    });
    if (values.redlineRpm.value == null && redlineRpm < peakPowerRpm + 300) {
      redlineRpm = Math.round(peakPowerRpm + 500);
      const note = estimates.find((e) => e.key === "redlineRpm");
      if (note) {
        note.value = redlineRpm;
        note.reason = "500 rpm above power peak";
      }
    }
    peakTorqueRpm = pick("peakTorqueRpm", values.peakTorqueRpm.value, () => {
      const guess = aspiration === "forced" ? (fuel === "diesel" ? 1750 : 1800) : Math.round(peakPowerRpm * 0.65);
      const maxConsistent = rpmNeeded; // T·ω at the torque peak must not exceed peak power
      return guess <= maxConsistent
        ? { value: guess, reason: aspiration === "forced" ? "Typical turbocharged torque onset" : "Typical NA torque peak (65% of power-peak speed)" }
        : { value: Math.round(maxConsistent), reason: "Highest speed consistent with stated peak power" };
    });
  }

  const curve: CurveParams = {
    peakPowerW,
    peakTorqueNm,
    peakPowerRpm,
    peakTorqueRpm,
    redlineRpm,
    idleRpm: isEv ? 0 : 900,
    shape: isEv ? "electric" : aspiration === "forced" || powertrain === "hybrid" ? "plateau" : "linear",
  };

  // --- Gearing -----------------------------------------------------------------------------
  const tireRadiusM = pick("tireRadiusM", values.tireRadiusM.value, () => estimateTireRadius(hints.bodyStyle));
  let gearRatios: number[];
  if (values.gearRatios.value && values.gearRatios.value.length > 0 && transmission !== "direct") {
    gearRatios = values.gearRatios.value;
    if (values.gearRatios.provenance === "estimated") {
      estimates.push({ key: "gearRatios", value: gearRatios, reason: values.gearRatios.note ?? "Estimated" });
    }
  } else {
    const count = transmission === "direct" ? 1 : values.gearCount.value ?? (transmission === "manual" ? 6 : 8);
    if (values.gearCount.value == null && transmission !== "direct" && transmission !== "cvt") {
      estimates.push({ key: "gearCount", value: count, reason: `Assumed ${count}-speed` });
    }
    const g = estimateGearRatios(transmission, count);
    gearRatios = g.ratios;
    if (transmission !== "direct") estimates.push({ key: "gearRatios", value: gearRatios, reason: g.reason });
  }
  const finalDrive = pick("finalDrive", values.finalDrive.value, () =>
    estimateFinalDrive(gearRatios[0], redlineRpm, tireRadiusM, transmission, powertrain),
  );
  const shiftTimeS =
    transmission === "direct" || transmission === "cvt"
      ? 0
      : pick("shiftTimeS", values.shiftTimeS.value, () => estimateShiftTime(transmission));

  const torqueConverter = transmission === "automatic" || transmission === "cvt";
  let launchRpm = 0;
  if (!isEv) {
    if (torqueConverter) {
      launchRpm = Math.min(aspiration === "forced" ? 2600 : 2400, peakPowerRpm * 0.6);
      estimates.push({ key: "launchRpm", value: Math.round(launchRpm), reason: "Typical torque-converter stall speed" });
    } else {
      launchRpm = Math.min(Math.max(peakTorqueRpm, redlineRpm * 0.45, 2500), redlineRpm * 0.65);
      estimates.push({ key: "launchRpm", value: Math.round(launchRpm), reason: "Clutch launch near torque peak" });
    }
  }

  // --- Chassis -----------------------------------------------------------------------------
  const curbMassKg = values.curbMassKg.value!;
  const payloadKg = pick("payloadKg", values.payloadKg.value, () => ({ value: 80, reason: "One 80 kg driver" }));
  const dragCoefficient = pick("dragCoefficient", values.dragCoefficient.value, () => estimateDragCoefficient(hints.bodyStyle));
  const frontalAreaM2 = pick("frontalAreaM2", values.frontalAreaM2.value, () => estimateFrontalArea(null, null, hints.bodyStyle));
  const drivetrainEfficiency = pick("drivetrainEfficiency", values.drivetrainEfficiency.value, () =>
    estimateEfficiency(drivetrain, powertrain),
  );
  const rollingResistance = pick("rollingResistance", values.rollingResistance.value, () => ({
    value: 0.011,
    reason: "Typical passenger tire on asphalt",
  }));
  const frontWeightFraction = pick("frontWeightFraction", values.frontWeightFraction.value, () =>
    estimateFrontWeight(drivetrain, powertrain),
  );
  const cgHeightRatio = pick("cgHeightRatio", values.cgHeightRatio.value, () => estimateCgRatio(hints.bodyStyle));
  const tireMu = pick("tireMu", values.tireMu.value, () => ({ value: 1.0, reason: "Typical street tire on dry asphalt" }));

  const surfaceFactor = SURFACE_OPTIONS.find((s) => s.value === conditions.surface)?.factor ?? 1;

  return {
    ok: true,
    estimates,
    inputs: {
      powertrain,
      aspiration,
      drivetrain,
      transmission,
      curve,
      gearRatios,
      finalDrive,
      shiftTimeS,
      launchRpm,
      torqueConverter,
      curbMassKg,
      payloadKg,
      massKg: curbMassKg + payloadKg,
      tireRadiusM,
      dragCoefficient,
      frontalAreaM2,
      drivetrainEfficiency,
      rollingResistance,
      frontWeightFraction,
      cgHeightRatio,
      tireMu,
      surfaceFactor,
      airDensity: airDensity(conditions.ambientTempC, conditions.elevationM),
      powerFactor: powerCorrectionFactor(conditions.ambientTempC, conditions.elevationM, aspiration),
    },
  };
}
