type SeedVehicle = {
  make: string;
  model: string;
  year: number;
  trim?: string;

  horsepower: number;
  torqueLbFt: number;
  weightKg: number;
  drivetrain?: string;
  dragCoefficient: number;

  benchmarkZeroToSixty?: number;
  benchmarkTopSpeedMph?: number;

  source: "NHTSA" | "User Input";
  confidence: number;
  notes: string[];
};

export const seedVehicles: SeedVehicle[] = [
  {
    make: "Lamborghini",
    model: "Huracan EVO",
    year: 2020,
    trim: "EVO",
    horsepower: 631,
    torqueLbFt: 443,
    weightKg: 1422,
    drivetrain: "AWD",
    dragCoefficient: 0.39,
    benchmarkZeroToSixty: 2.9,
    benchmarkTopSpeedMph: 202,
    source: "User Input",
    confidence: 0.88,
    notes: [
      "Seed vehicle used for reliable demo testing.",
      "Specs are intended for simulation demonstration, not official certification.",
    ],
  },
  {
    make: "Mercedes-Benz",
    model: "C240 4MATIC",
    year: 2005,
    trim: "C240 4MATIC",
    horsepower: 168,
    torqueLbFt: 177,
    weightKg: 1625,
    drivetrain: "AWD",
    dragCoefficient: 0.29,
    benchmarkZeroToSixty: 8.5,
    benchmarkTopSpeedMph: 137,
    source: "User Input",
    confidence: 0.82,
    notes: [
      "Seed vehicle used for testing year/make/model search behavior.",
      "Performance values are estimated for demo simulation.",
    ],
  },
];