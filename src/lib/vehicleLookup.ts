import { seedVehicles } from "@/data/seedVehicles";
import { buildEstimatedVehicle } from "@/lib/normalizeVehicle";
import type { VehicleSpecs } from "@/lib/vehicleTypes";

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function estimateFrontalAreaM2(make: string, model: string) {
  const text = `${make} ${model}`.toLowerCase();

  if (text.includes("lamborghini") || text.includes("ferrari")) return 2.0;
  if (text.includes("tesla")) return 2.22;
  if (text.includes("truck") || text.includes("f-150")) return 2.9;
  if (text.includes("suv")) return 2.65;

  return 2.2;
}

function estimateDrivetrainLoss(drivetrain?: string) {
  const normalized = drivetrain?.toLowerCase() ?? "";

  if (normalized.includes("awd") || normalized.includes("4matic")) return 0.2;
  if (normalized.includes("rwd")) return 0.15;
  if (normalized.includes("fwd")) return 0.13;

  return 0.15;
}

function estimateTireGrip(make: string, model: string) {
  const text = `${make} ${model}`.toLowerCase();

  if (text.includes("lamborghini") || text.includes("ferrari")) return 1.15;
  if (text.includes("tesla")) return 1.08;
  if (text.includes("mustang") || text.includes("camaro")) return 1.0;

  return 0.95;
}

function seedVehicleSearchText(vehicle: (typeof seedVehicles)[number]) {
  return [
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.trim,
  ]
    .filter(Boolean)
    .join(" ");
}

function seedToVehicleSpecs(vehicle: (typeof seedVehicles)[number]): VehicleSpecs {
  return {
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim,
    horsepower: vehicle.horsepower,
    modifiedHorsepower: vehicle.horsepower,
    torqueLbFt: vehicle.torqueLbFt,
    weightKg: vehicle.weightKg,
    drivetrain: vehicle.drivetrain,
    dragCoefficient: vehicle.dragCoefficient,
    frontalAreaM2: estimateFrontalAreaM2(vehicle.make, vehicle.model),
    drivetrainLoss: estimateDrivetrainLoss(vehicle.drivetrain),
    tireGrip: estimateTireGrip(vehicle.make, vehicle.model),
    source: vehicle.source,
    notes: [
      ...vehicle.notes,
      "Additional simulation values were normalized from seed vehicle data.",
    ],
  };
}

function parseQuery(query: string) {
  const cleaned = query.trim();

  const yearMatch = cleaned.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;

  const withoutYear = cleaned.replace(/\b(19|20)\d{2}\b/, "").trim();
  const parts = withoutYear.split(/\s+/).filter(Boolean);

  return {
    year,
    make: parts[0] ?? "",
    model: parts.slice(1).join(" "),
  };
}

export async function lookupVehicle(query: string): Promise<VehicleSpecs> {
  const normalizedQuery = normalizeText(query);

  const exactSeedMatch = seedVehicles.find((vehicle) => {
    const searchText = normalizeText(seedVehicleSearchText(vehicle));

    return (
      searchText.includes(normalizedQuery) ||
      normalizedQuery.includes(searchText)
    );
  });

  if (exactSeedMatch) {
    return seedToVehicleSpecs(exactSeedMatch);
  }

  const looseSeedMatch = seedVehicles.find((vehicle) => {
    const make = normalizeText(vehicle.make);
    const model = normalizeText(vehicle.model);
    const trim = normalizeText(vehicle.trim ?? "");

    const hasMake = make.length > 0 && normalizedQuery.includes(make);
    const hasModel = model.length > 0 && normalizedQuery.includes(model);
    const hasTrim = trim.length > 0 && normalizedQuery.includes(trim);

    return hasMake && (hasModel || hasTrim);
  });

  if (looseSeedMatch) {
    return seedToVehicleSpecs(looseSeedMatch);
  }

  const apiKey = process.env.API_NINJAS_KEY;

  if (!apiKey) {
    return buildEstimatedVehicle(query);
  }

  try {
    const parsed = parseQuery(query);

    if (!parsed.make || !parsed.model) {
      return buildEstimatedVehicle(query);
    }

    const response = await fetch(
      `https://api.api-ninjas.com/v1/cars?make=${encodeURIComponent(
        parsed.make
      )}&model=${encodeURIComponent(parsed.model)}`,
      {
        headers: {
          "X-Api-Key": apiKey,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      return buildEstimatedVehicle(query);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return buildEstimatedVehicle(query);
    }

    const first = data[0];
    const estimated = buildEstimatedVehicle(query);

    return {
      ...estimated,
      year: Number(first.year) || parsed.year || estimated.year,
      make: first.make ?? estimated.make,
      model: first.model ?? estimated.model,
      source: "User Input",
      notes: [
        "Vehicle identity was fetched from API Ninjas.",
        "Performance fields were estimated because free APIs usually do not include horsepower, drag coefficient, frontal area, 0-60, or top speed.",
      ],
    };
  } catch {
    return buildEstimatedVehicle(query);
  }
}