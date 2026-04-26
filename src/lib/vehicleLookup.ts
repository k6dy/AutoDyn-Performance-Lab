import { seedVehicles } from "@/data/seedVehicles";
import { buildEstimatedVehicle } from "@/lib/normalizeVehicle";
import type { VehicleSpecs } from "@/lib/vehicleTypes";

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function lookupVehicle(query: string): Promise<VehicleSpecs> {
  const normalizedQuery = normalizeText(query);

  const seedMatch = seedVehicles.find((vehicle) =>
    normalizeText(vehicle.name).includes(normalizedQuery)
  );

  if (seedMatch) {
    return seedMatch;
  }

  const looseSeedMatch = seedVehicles.find((vehicle) => {
    const make = normalizeText(vehicle.make ?? "");
    const model = normalizeText(vehicle.model ?? "");
    return normalizedQuery.includes(make) && normalizedQuery.includes(model);
  });

  if (looseSeedMatch) {
    return looseSeedMatch;
  }

  const apiKey = process.env.API_NINJAS_KEY;

  if (!apiKey) {
    return buildEstimatedVehicle(query);
  }

  try {
    const parts = query.trim().split(" ");
    const make = parts[0];
    const model = parts.slice(1).join(" ");

    const response = await fetch(
      `https://api.api-ninjas.com/v1/cars?make=${encodeURIComponent(
        make
      )}&model=${encodeURIComponent(model)}`,
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
      name: `${first.year ?? estimated.year ?? ""} ${
        first.make ?? estimated.make
      } ${first.model ?? estimated.model}`.trim(),
      year: Number(first.year) || estimated.year,
      make: first.make ?? estimated.make,
      model: first.model ?? estimated.model,
      source: "hybrid",
      confidence: 0.58,
      notes: [
        "Vehicle identity was fetched from API Ninjas.",
        "Performance fields were estimated because free API data may not include horsepower, Cd, frontal area, 0–60, or top speed.",
      ],
    };
  } catch {
    return buildEstimatedVehicle(query);
  }
}