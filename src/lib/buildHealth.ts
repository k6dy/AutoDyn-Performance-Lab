import type { BuildHealth, VehicleSpecs } from "@/lib/vehicleTypes";

export function evaluateBuildHealth(vehicle: VehicleSpecs): BuildHealth {
  const warnings: string[] = [];

  const hpIncreaseRatio = vehicle.modifiedHorsepower / vehicle.horsepower;
  const hpPerKg = vehicle.modifiedHorsepower / vehicle.weightKg;
  const drivetrain = vehicle.drivetrain?.toLowerCase() ?? "";

  if (vehicle.modifiedHorsepower >= 10000) {
    return {
      status: "FAIL",
      title: "Mechanical Failure: Non-Viable Build",
      message:
        "This power level is outside the practical operating range for a production-based vehicle platform.",
      warnings: [
        "Engine, transmission, axles, tires, cooling, fuel delivery, and chassis structure would require complete race-platform redesign.",
        "Simulation result should be treated as theoretical only.",
      ],
    };
  }

  if (hpIncreaseRatio > 3) {
    warnings.push(
      "Modified output exceeds 3x stock power. Stock internals and drivetrain would not be expected to survive."
    );
  }

  if (hpIncreaseRatio > 2) {
    warnings.push(
      "Power increase exceeds 2x stock output. Supporting engine, cooling, fuel, and drivetrain upgrades are required."
    );
  }

  if (hpPerKg > 0.75) {
    warnings.push(
      "Power-to-weight ratio is extremely aggressive and may be difficult to control on street tires."
    );
  }

  if (
    drivetrain.includes("front") &&
    vehicle.modifiedHorsepower > 450
  ) {
    warnings.push(
      "Front-wheel-drive layout is likely traction-limited at this power level."
    );
  }

  if (
    (drivetrain.includes("all") || drivetrain.includes("awd")) &&
    vehicle.modifiedHorsepower > 900
  ) {
    warnings.push(
      "AWD drivetrain shock load may become a major reliability bottleneck."
    );
  }

  if (vehicle.tireGrip < 0.9) {
    warnings.push(
      "Low tire grip coefficient will limit launch performance regardless of horsepower."
    );
  }

  if (warnings.length >= 3) {
    return {
      status: "FAIL",
      title: "Build Feasibility: High Risk",
      message:
        "The configuration exceeds multiple mechanical or traction constraints and should be considered non-viable without major redesign.",
      warnings,
    };
  }

  if (warnings.length > 0) {
    return {
      status: "WARNING",
      title: "Build Feasibility: Constrained",
      message:
        "The setup may be possible, but the added power is likely limited by mechanical reliability, drivetrain strength, or tire grip.",
      warnings,
    };
  }

  return {
    status: "SAFE",
    title: "Build Feasibility: Functional Range",
    message:
      "The configuration stays within a reasonable simulation range and should translate power into measurable performance gains.",
    warnings: [],
  };
}