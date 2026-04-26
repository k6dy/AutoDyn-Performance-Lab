const NHTSA_BASE = "https://vpic.nhtsa.dot.gov/api";

export type NhtsaMake = {
  MakeId: number;
  MakeName: string;
  VehicleTypeId: number;
  VehicleTypeName: string;
};

export type NhtsaModel = {
  Make_ID: number;
  Make_Name: string;
  Model_ID: number;
  Model_Name: string;
};

export async function getAllMakes() {
  const response = await fetch(
    `${NHTSA_BASE}/vehicles/GetMakesForVehicleType/car?format=json`,
    { cache: "no-store" }
  );

  const data = await response.json();

  return (data.Results ?? []) as NhtsaMake[];
}

export async function getModelsForMakeYear(make: string, year: number) {
  const response = await fetch(
    `${NHTSA_BASE}/vehicles/GetModelsForMakeYear/make/${encodeURIComponent(
      make
    )}/modelyear/${year}/vehicleType/car?format=json`,
    { cache: "no-store" }
  );

  const data = await response.json();

  return (data.Results ?? []) as NhtsaModel[];
}

export async function validateVehicle(make: string, model: string, year: number) {
  const models = await getModelsForMakeYear(make, year);

  const match = models.find(
    (item) => item.Model_Name.toLowerCase() === model.toLowerCase()
  );

  if (!match) return null;

  return {
    make: match.Make_Name,
    model: match.Model_Name,
    year,
    source: "NHTSA" as const,
  };
}