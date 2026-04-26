import { NextResponse } from "next/server";
import { evaluateBuildHealth } from "@/lib/buildHealth";
import { simulateVehicle } from "@/lib/simulator";
import type { VehicleSpecs } from "@/lib/vehicleTypes";

export async function POST(request: Request) {
  const body = await request.json();

  const {
    make,
    model,
    trim,
    year,
    horsepower,
    modifiedHorsepower,
    weightKg,
    dragCoefficient,
    frontalAreaM2,
    drivetrainLoss,
    tireGrip,
    engine,
    torqueLbFt,
    drivetrain,
    transmission,
    bodyStyle,
  } = body;

  const vehicle: VehicleSpecs = {
    make,
    model,
    year: Number(year),
    source: "User Input",
    trim: trim || undefined,
    horsepower: Number(horsepower),
    modifiedHorsepower: Number(modifiedHorsepower),
    weightKg: Number(weightKg),
    dragCoefficient: Number(dragCoefficient),
    frontalAreaM2: Number(frontalAreaM2),
    drivetrainLoss: Number(drivetrainLoss),
    tireGrip: Number(tireGrip),
    engine: engine || "Unavailable",
    torqueLbFt: torqueLbFt ? Number(torqueLbFt) : null,
    drivetrain,
    transmission,
    bodyStyle,
    notes: [
      "Vehicle selection and specs come from the local CarAPI v2 dataset.",
      "Simulation uses stock vs modified horsepower with estimated aero and drivetrain assumptions when exact values are unavailable.",
    ],
  };

  const simulation = simulateVehicle(vehicle);
  const buildHealth = evaluateBuildHealth(vehicle);

  return NextResponse.json({
    vehicle,
    simulation,
    buildHealth,
  });
}