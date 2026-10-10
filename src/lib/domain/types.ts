// Shared domain model. Every stored value is SI; provenance travels with each value.

export type Provenance = "verified" | "user" | "estimated" | "unavailable";

export type SpecValue<T> = {
  value: T | null;
  provenance: Provenance;
  /**
   * Modified scenario only: a change relative to stock (SI). When present the effective value is
   * always stock + delta, so later edits to the stock baseline carry through.
   */
  delta?: number;
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

export type WeightEstimate = {
  kg: number;
  lowKg: number;
  highKg: number;
  method: "same-model" | "model-years" | "class";
  classId?: string;
  basis: string;
};

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
  /** Offered (not applied) when the source has no curb weight. */
  weightEstimate?: WeightEstimate;
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

/**
 * Optional, explicitly supplied engineering constraints and performance claims (SI). They are
 * not physics inputs: the feasibility engine checks the configuration and results against them.
 */
export type ScenarioConstraints = {
  /** Claimed 0–60 mph time, s. */
  claimedZeroTo60S?: number | null;
  /** Claimed top speed, m/s. */
  claimedTopSpeedMs?: number | null;
  /** Stated torque capacity of the transmission/driveline (engine-side), N·m. */
  drivetrainTorqueLimitNm?: number | null;
  /** Stated tire speed rating, m/s. */
  tireSpeedRatingMs?: number | null;
};

export const CONSTRAINT_KEYS = ["claimedZeroTo60S", "claimedTopSpeedMs", "drivetrainTorqueLimitNm", "tireSpeedRatingMs"] as const;
export type ConstraintKey = (typeof CONSTRAINT_KEYS)[number];

export type ModifiedScenario = {
  overrides: Partial<SpecValues>;
};

export type ScenarioId = "stock" | "modified";

export type AnalysisConfig = {
  stock: SpecSet | null;
  modified: ModifiedScenario | null;
  conditions: Conditions;
  /** Per-scenario claims and component ratings; Modified inherits Stock's unless overridden. */
  constraints?: { stock?: ScenarioConstraints; modified?: ScenarioConstraints };
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
