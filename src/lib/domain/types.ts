// Shared domain model. Every stored value is SI; provenance travels with each value.

export type Provenance = "verified" | "user" | "estimated" | "unavailable";

export type SpecValue<T> = {
  value: T | null;
  provenance: Provenance;
  /** Where a verified value came from, or why an estimate was chosen. */
  source?: string;
  note?: string;
};

export type Powertrain = "ice" | "hybrid" | "ev";
export type Aspiration = "na" | "forced" | "electric";
export type Drivetrain = "FWD" | "RWD" | "AWD" | "4WD";
export type TransmissionType = "automatic" | "manual" | "dct" | "cvt" | "direct";
export type Surface = "dry" | "wet" | "prepped" | "gravel" | "snow";

export const NUMERIC_KEYS = [
  "peakPowerKw",
  "peakPowerRpm",
  "peakTorqueNm",
  "peakTorqueRpm",
  "redlineRpm",
  "gearCount",
  "finalDrive",
  "shiftTimeS",
  "curbMassKg",
  "payloadKg",
  "tireRadiusM",
  "dragCoefficient",
  "frontalAreaM2",
  "drivetrainEfficiency",
  "rollingResistance",
  "frontWeightFraction",
  "cgHeightRatio",
  "tireMu",
] as const;

export type NumericSpecKey = (typeof NUMERIC_KEYS)[number];

export const ENUM_KEYS = ["powertrain", "aspiration", "drivetrain", "transmission"] as const;
export type EnumSpecKey = (typeof ENUM_KEYS)[number];

export type SpecValues = { [K in NumericSpecKey]: SpecValue<number> } & {
  powertrain: SpecValue<Powertrain>;
  aspiration: SpecValue<Aspiration>;
  drivetrain: SpecValue<Drivetrain>;
  transmission: SpecValue<TransmissionType>;
  gearRatios: SpecValue<number[]>;
};

export type SpecKey = keyof SpecValues;
export const SPEC_KEYS: SpecKey[] = [...ENUM_KEYS, ...NUMERIC_KEYS, "gearRatios"];

export type VehicleSource = "dataset" | "nhtsa" | "vin" | "custom";

export type VehicleIdentity = {
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  source: VehicleSource;
  /** Human-readable data source, e.g. "CarAPI dataset (trim 22882)". */
  sourceDetail: string;
  datasetTrimId?: string;
  engineDescription?: string;
  bodyStyle?: string;
  fuel?: "gas" | "diesel" | "electric" | "other";
  notes: string[];
};

export type SpecSet = {
  identity: VehicleIdentity;
  values: SpecValues;
};

export type Conditions = {
  ambientTempC: number;
  elevationM: number;
  surface: Surface;
  /** Subtract the first foot of travel from 0–60 times (US magazine convention). */
  rollout: boolean;
};

export type ModifiedScenario = {
  overrides: Partial<SpecValues>;
};

export type ScenarioId = "stock" | "modified";

export type AnalysisConfig = {
  stock: SpecSet | null;
  modified: ModifiedScenario | null;
  conditions: Conditions;
};

export const DEFAULT_CONDITIONS: Conditions = {
  ambientTempC: 25,
  elevationM: 0,
  surface: "dry",
  rollout: false,
};

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  verified: "Verified",
  user: "User-provided",
  estimated: "Estimated",
  unavailable: "Unavailable",
};
