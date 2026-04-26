import type { VehicleSpecs } from "@/lib/vehicleTypes";

function estimateCd(make: string, model: string) {
  const text = `${make} ${model}`.toLowerCase();

  if (text.includes("tesla")) return 0.23;
  if (text.includes("lamborghini") || text.includes("ferrari")) return 0.36;
  if (text.includes("mustang") || text.includes("camaro")) return 0.35;
  if (text.includes("truck") || text.includes("f-150")) return 0.45;
  if (text.includes("suv")) return 0.38;

  return 0.32;
}

function estimateFrontalArea(make: string, model: string) {
  const text = `${make} ${model}`.toLowerCase();

  if (text.includes("lamborghini") || text.includes("ferrari")) return 2.0;
  if (text.includes("tesla")) return 2.22;
  if (text.includes("truck") || text.includes("f-150")) return 2.9;
  if (text.includes("suv")) return 2.65;

  return 2.2;
}

function estimateWeightKg(horsepower: number, make: string, model: string) {
  const text = `${make} ${model}`.toLowerCase();

  if (text.includes("lamborghini") || text.includes("ferrari")) return 1500;
  if (text.includes("tesla")) return 1850;
  if (text.includes("truck") || text.includes("f-150")) return 2200;
  if (horsepower > 500) return 1700;
  if (horsepower > 300) return 1600;
  if (horsepower > 200) return 1400;

  return 1300;
}

function estimateZeroToSixty(horsepower: number, weightKg: number, tireGrip: number) {
  const powerToWeight = horsepower / weightKg;
  const raw = 9.8 / Math.max(powerToWeight * tireGrip * 8, 0.1);

  return Number(Math.max(2.4, Math.min(raw, 12)).toFixed(1));
}

function estimateTopSpeed(
  horsepower: number,
  dragCoefficient: number,
  frontalAreaM2: number
) {
  const airDensity = 1.225;
  const powerWatts = horsepower * 745.7 * 0.85;

  const speedMs = Math.pow(
    (2 * powerWatts) / (airDensity * dragCoefficient * frontalAreaM2),
    1 / 3
  );

  return Number((speedMs * 2.23694).toFixed(0));
}

export function buildEstimatedVehicle(query: string): VehicleSpecs {
  const cleaned = query.trim();

  const yearMatch = cleaned.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;

  const words = cleaned.replace(/\b(19|20)\d{2}\b/, "").trim().split(" ");

  const make = words[0] ?? "Unknown";
  const model = words.slice(1).join(" ") || "Unknown Model";

  const lower = cleaned.toLowerCase();

  let horsepower = 300;
  let tireGrip = 0.95;
  let drivetrainLoss = 0.15;

  if (lower.includes("lamborghini")) {
    horsepower = 631;
    tireGrip = 1.15;
  } else if (lower.includes("ferrari")) {
    horsepower = 650;
    tireGrip = 1.12;
  } else if (lower.includes("tesla")) {
    horsepower = 450;
    tireGrip = 1.08;
    drivetrainLoss = 0.08;
  } else if (lower.includes("mustang")) {
    horsepower = 480;
    tireGrip = 1.0;
  } else if (lower.includes("gr86") || lower.includes("brz")) {
    horsepower = 228;
    tireGrip = 0.95;
  }

  const weightKg = estimateWeightKg(horsepower, make, model);
  const dragCoefficient = estimateCd(make, model);
  const frontalAreaM2 = estimateFrontalArea(make, model);

  return {
    name: year ? `${year} ${make} ${model}` : `${make} ${model}`,
    year,
    make,
    model,
    horsepower,
    weightKg,
    dragCoefficient,
    frontalAreaM2,
    drivetrainLoss,
    tireGrip,
    benchmarkZeroToSixty: estimateZeroToSixty(horsepower, weightKg, tireGrip),
    benchmarkTopSpeedMph: estimateTopSpeed(
      horsepower,
      dragCoefficient,
      frontalAreaM2
    ),
    source: "estimated",
    confidence: 0.45,
    notes: [
      "Vehicle was generated from estimator fallback.",
      "Use exact trim/year for better results.",
      "Some values are estimated because free APIs often lack full performance data.",
    ],
  };
}