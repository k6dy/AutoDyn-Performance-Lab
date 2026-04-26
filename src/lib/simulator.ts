import type {
  SimulationPoint,
  SimulationResult,
  VehicleSpecs,
} from "@/lib/vehicleTypes";

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const DT = 0.03;

const GEAR_RATIOS = [3.7, 2.25, 1.55, 1.15, 0.85, 0.67];
const FINAL_DRIVE = 3.42;
const TIRE_RADIUS_M = 0.34;
const SHIFT_TIME = 0.28;
const ROLLING_RESISTANCE_COEFFICIENT = 0.015;

function msToMph(ms: number) {
  return ms / 0.44704;
}

function estimateTorqueFromHorsepower(horsepower: number, rpm = 5500) {
  return (horsepower * 5252) / rpm;
}

function getTractionMultiplier(drivetrain?: string) {
  const value = drivetrain?.toLowerCase() ?? "";

  if (value.includes("awd") || value.includes("all")) return 1.12;
  if (value.includes("4wd")) return 1.08;
  if (value.includes("rear") || value.includes("rwd")) return 1.0;
  if (value.includes("front") || value.includes("fwd")) return 0.88;

  return 1.0;
}

function getWheelForce(
  torqueLbFt: number,
  gearRatio: number,
  drivetrainLoss: number
) {
  const torqueNm = torqueLbFt * 1.35582;
  const wheelTorque =
    torqueNm * gearRatio * FINAL_DRIVE * (1 - drivetrainLoss);

  return wheelTorque / TIRE_RADIUS_M;
}

function runSingleSimulation(vehicle: VehicleSpecs, horsepower: number) {
  const mass = vehicle.weightKg;

  const torque =
    vehicle.torqueLbFt && horsepower === vehicle.horsepower
      ? vehicle.torqueLbFt
      : estimateTorqueFromHorsepower(horsepower);

  let time = 0;
  let velocity = 0;
  let gearIndex = 0;
  let shiftTimer = 0;
  let zeroToSixty: number | null = null;

  let tractionLimitedFrames = 0;
  let dragLimitedFrames = 0;

  const points: {
    time: number;
    speedMph: number;
  }[] = [];

  while (time < 35) {
    const currentSpeedMph = msToMph(velocity);

    if (
      currentSpeedMph > 28 * (gearIndex + 1) &&
      gearIndex < GEAR_RATIOS.length - 1
    ) {
      gearIndex += 1;
      shiftTimer = SHIFT_TIME;
    }

    const rawDriveForce =
      shiftTimer > 0
        ? 0
        : getWheelForce(
            torque,
            GEAR_RATIOS[gearIndex],
            vehicle.drivetrainLoss
          );

    const tractionLimit =
      mass *
      GRAVITY *
      vehicle.tireGrip *
      getTractionMultiplier(vehicle.drivetrain);

    const usableDriveForce = Math.min(rawDriveForce, tractionLimit);

    if (rawDriveForce > tractionLimit) {
      tractionLimitedFrames += 1;
    }

    const dragForce =
      0.5 *
      AIR_DENSITY *
      vehicle.dragCoefficient *
      vehicle.frontalAreaM2 *
      velocity *
      velocity;

    const rollingResistance =
      ROLLING_RESISTANCE_COEFFICIENT * mass * GRAVITY;

    const netForce = usableDriveForce - dragForce - rollingResistance;
    const acceleration = Math.max(netForce / mass, 0);

    if (dragForce > usableDriveForce * 0.85 && currentSpeedMph > 60) {
      dragLimitedFrames += 1;
    }

    velocity += acceleration * DT;
    time += DT;

    const speedMph = msToMph(velocity);

    if (zeroToSixty === null && speedMph >= 60) {
      zeroToSixty = Number(time.toFixed(2));
    }

    points.push({
      time: Number(time.toFixed(2)),
      speedMph: Number(speedMph.toFixed(2)),
    });

    if (shiftTimer > 0) {
      shiftTimer -= DT;
    }

    if (speedMph > 240) break;
    if (time > 8 && acceleration < 0.015 && speedMph > 70) break;
  }

  return {
    zeroToSixty,
    topSpeedMph: Number((points.at(-1)?.speedMph ?? 0).toFixed(1)),
    tractionLimitedFrames,
    dragLimitedFrames,
    points,
  };
}

export function simulateVehicle(vehicle: VehicleSpecs): SimulationResult {
  const hasModification =
    Number(vehicle.modifiedHorsepower) !== Number(vehicle.horsepower);

  const stock = runSingleSimulation(vehicle, vehicle.horsepower);

  if (!hasModification) {
    return {
      hasModification: false,
      stockZeroToSixty: stock.zeroToSixty,
      modifiedZeroToSixty: null,
      stockTopSpeedMph: stock.topSpeedMph,
      modifiedTopSpeedMph: null,
      improvementPercent: null,
      data: stock.points.map((point) => ({
        time: point.time,
        stockSpeedMph: point.speedMph,
      })),
      insights: [
        "No modified simulation is shown because modified horsepower matches stock horsepower.",
        "Increase Modified HP to compare how added power changes acceleration and estimated top speed.",
      ],
    };
  }

  const modified = runSingleSimulation(vehicle, vehicle.modifiedHorsepower);

  const maxLength = Math.max(stock.points.length, modified.points.length);

  const data: SimulationPoint[] = Array.from({ length: maxLength }).map(
    (_, index) => ({
      time: stock.points[index]?.time ?? modified.points[index]?.time ?? 0,
      stockSpeedMph:
        stock.points[index]?.speedMph ?? stock.points.at(-1)?.speedMph ?? 0,
      modifiedSpeedMph:
        modified.points[index]?.speedMph ??
        modified.points.at(-1)?.speedMph ??
        0,
    })
  );

  const improvementPercent =
    stock.zeroToSixty && modified.zeroToSixty
      ? Number(
          (
            ((stock.zeroToSixty - modified.zeroToSixty) /
              stock.zeroToSixty) *
            100
          ).toFixed(1)
        )
      : null;

  const insights: string[] = [];

  if (
    modified.tractionLimitedFrames > stock.tractionLimitedFrames * 1.2 &&
    vehicle.modifiedHorsepower > vehicle.horsepower
  ) {
    insights.push(
      "Modified setup is traction-limited: added horsepower is not fully converting into launch acceleration."
    );
  }

  if (modified.dragLimitedFrames > 25) {
    insights.push(
      "High-speed performance is limited by aerodynamic drag, so top-speed gains may flatten out."
    );
  }

  if (
    improvementPercent !== null &&
    improvementPercent < 5 &&
    vehicle.modifiedHorsepower > vehicle.horsepower * 1.25
  ) {
    insights.push(
      "Large horsepower increase produced limited 0–60 improvement, likely due to grip, gearing, or drivetrain limits."
    );
  }

  if (vehicle.drivetrain?.toLowerCase().includes("front")) {
    insights.push(
      "Front-wheel-drive layout can reduce launch efficiency at higher power levels."
    );
  }

  if (insights.length === 0) {
    insights.push(
      "Modified output produced measurable performance gains in the simulation."
    );
  }

  return {
    hasModification: true,
    stockZeroToSixty: stock.zeroToSixty,
    modifiedZeroToSixty: modified.zeroToSixty,
    stockTopSpeedMph: stock.topSpeedMph,
    modifiedTopSpeedMph: modified.topSpeedMph,
    improvementPercent,
    data,
    insights,
  };
}