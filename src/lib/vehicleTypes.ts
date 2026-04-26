export type VehicleIdentity = {
  make: string;
  model: string;
  year: number;
  source: "NHTSA" | "User Input";
};

export type VehicleSpecs = VehicleIdentity & {
  trim?: string;
  drivetrain?: string;
  transmission?: string;
  bodyStyle?: string;

  horsepower: number;
  modifiedHorsepower: number;
  weightKg: number;
  dragCoefficient: number;
  frontalAreaM2: number;
  drivetrainLoss: number;
  tireGrip: number;

  engine?: string;
  torqueLbFt?: number | null;
  notes: string[];
};

export type SimulationPoint = {
  time: number;
  stockSpeedMph: number;
  modifiedSpeedMph?: number;
};

export type SimulationResult = {
  hasModification: boolean;
  stockZeroToSixty: number | null;
  modifiedZeroToSixty: number | null;
  stockTopSpeedMph: number;
  modifiedTopSpeedMph: number | null;
  improvementPercent: number | null;
  data: SimulationPoint[];
  insights: string[];
};

export type BuildHealth = {
  status: "SAFE" | "WARNING" | "FAIL";
  title: string;
  message: string;
  warnings: string[];
};