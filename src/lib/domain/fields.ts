import type { Quantity } from "@/lib/units";
import type {
  Aspiration,
  Drivetrain,
  NumericSpecKey,
  Powertrain,
  SpecKey,
  SpecValue,
  SpecValues,
  Surface,
  TransmissionType,
} from "@/lib/domain/types";

export type Section = "powertrain" | "vehicle";

export type NumericFieldDef = {
  key: NumericSpecKey;
  label: string;
  /** Label override for electric powertrains. */
  evLabel?: string;
  quantity: Quantity;
  section: Section;
  tier: "basic" | "advanced";
  /** Physically impossible outside this range (SI). */
  hard: [number, number];
  /** Unusual outside this range — warn and ask for confirmation. */
  typical: [number, number];
  integer?: boolean;
  required?: boolean;
  /** Whether AutoDyn can estimate the value when it is missing. */
  estimable: boolean;
  digits: number;
  help: string;
};

export const NUMERIC_FIELDS: Record<NumericSpecKey, NumericFieldDef> = {
  peakPowerKw: {
    key: "peakPowerKw", label: "Peak power", quantity: "power", section: "powertrain", tier: "basic",
    hard: [1, 5000], typical: [30, 900], required: true, estimable: false, digits: 0,
    help: "Rated peak output (SAE net for US-market data). Required — AutoDyn will not guess power.",
  },
  peakTorqueNm: {
    key: "peakTorqueNm", label: "Peak torque", quantity: "torque", section: "powertrain", tier: "basic",
    hard: [1, 20000], typical: [50, 1500], estimable: true, digits: 0,
    help: "If unknown, estimated from peak power and an assumed power-peak speed (low confidence).",
  },
  peakPowerRpm: {
    key: "peakPowerRpm", label: "Power peak speed", evLabel: "Base motor speed", quantity: "rpm", section: "powertrain", tier: "advanced",
    hard: [300, 30000], typical: [2500, 9500], integer: true, estimable: true, digits: 0,
    help: "Engine speed at peak power. Estimated from redline when unknown.",
  },
  peakTorqueRpm: {
    key: "peakTorqueRpm", label: "Torque peak speed", quantity: "rpm", section: "powertrain", tier: "advanced",
    hard: [300, 30000], typical: [1000, 8000], integer: true, estimable: true, digits: 0,
    help: "Engine speed where peak torque begins. Turbocharged engines often reach it near 1,500–2,000 rpm.",
  },
  redlineRpm: {
    key: "redlineRpm", label: "Redline", evLabel: "Max motor speed", quantity: "rpm", section: "powertrain", tier: "advanced",
    hard: [1000, 30000], typical: [4000, 20000], integer: true, estimable: true, digits: 0,
    help: "Maximum engine (or motor) speed used for shifting and top-speed limits.",
  },
  gearCount: {
    key: "gearCount", label: "Forward gears", quantity: "count", section: "powertrain", tier: "advanced",
    hard: [1, 12], typical: [1, 10], integer: true, estimable: true, digits: 0,
    help: "Number of forward ratios. Parsed from the transmission description when available.",
  },
  finalDrive: {
    key: "finalDrive", label: "Final drive ratio", evLabel: "Reduction ratio", quantity: "ratio", section: "powertrain", tier: "advanced",
    hard: [0.5, 30], typical: [2, 12], estimable: true, digits: 2,
    help: "When unknown, sized so first gear tops out at a typical speed at redline (estimate).",
  },
  shiftTimeS: {
    key: "shiftTimeS", label: "Shift interruption", quantity: "time", section: "powertrain", tier: "advanced",
    hard: [0, 3], typical: [0, 0.8], estimable: true, digits: 2,
    help: "Effective time with no drive torque per upshift. Defaults depend on transmission type.",
  },
  curbMassKg: {
    key: "curbMassKg", label: "Curb mass", quantity: "mass", section: "vehicle", tier: "basic",
    hard: [50, 50000], typical: [700, 3500], required: true, estimable: false, digits: 0,
    help: "Vehicle mass with fluids, without occupants. Required — AutoDyn will not guess mass.",
  },
  payloadKg: {
    key: "payloadKg", label: "Driver & payload", quantity: "mass", section: "vehicle", tier: "basic",
    hard: [0, 5000], typical: [0, 400], estimable: true, digits: 0,
    help: "Added test mass. Defaults to one 80 kg (176 lb) driver.",
  },
  dragCoefficient: {
    key: "dragCoefficient", label: "Drag coefficient (Cd)", quantity: "coefficient", section: "vehicle", tier: "basic",
    hard: [0.05, 2], typical: [0.2, 0.6], estimable: true, digits: 3,
    help: "Estimated from body style when the manufacturer figure is unknown.",
  },
  frontalAreaM2: {
    key: "frontalAreaM2", label: "Frontal area", quantity: "area", section: "vehicle", tier: "basic",
    hard: [0.3, 15], typical: [1.5, 4], estimable: true, digits: 2,
    help: "Estimated as 0.84 × width × height when body dimensions are known.",
  },
  drivetrainEfficiency: {
    key: "drivetrainEfficiency", label: "Drivetrain efficiency", quantity: "fraction", section: "vehicle", tier: "basic",
    hard: [0.3, 1], typical: [0.75, 0.97], estimable: true, digits: 0,
    help: "Fraction of crank power reaching the wheels. Estimated by drivetrain layout.",
  },
  tireMu: {
    key: "tireMu", label: "Tire friction (μ)", quantity: "coefficient", section: "vehicle", tier: "basic",
    hard: [0.1, 3], typical: [0.6, 1.4], estimable: true, digits: 2,
    help: "Peak longitudinal friction on dry asphalt. 1.0 ≈ street tire, 1.1–1.2 ≈ performance summer tire.",
  },
  tireRadiusM: {
    key: "tireRadiusM", label: "Tire rolling radius", quantity: "radius", section: "vehicle", tier: "advanced",
    hard: [0.1, 1.5], typical: [0.26, 0.45], estimable: true, digits: 1,
    help: "Loaded radius of the driven tires. Enter a tire size to calculate it.",
  },
  rollingResistance: {
    key: "rollingResistance", label: "Rolling resistance (Crr)", quantity: "coefficient", section: "vehicle", tier: "advanced",
    hard: [0.001, 0.2], typical: [0.006, 0.02], estimable: true, digits: 4,
    help: "Typical passenger tires on asphalt: 0.008–0.013.",
  },
  frontWeightFraction: {
    key: "frontWeightFraction", label: "Front weight share", quantity: "fraction", section: "vehicle", tier: "advanced",
    hard: [0.2, 0.8], typical: [0.38, 0.65], estimable: true, digits: 0,
    help: "Static share of weight on the front axle. Affects traction for 2WD layouts.",
  },
  cgHeightRatio: {
    key: "cgHeightRatio", label: "CG height ÷ wheelbase", quantity: "coefficient", section: "vehicle", tier: "advanced",
    hard: [0.05, 0.6], typical: [0.14, 0.32], estimable: true, digits: 2,
    help: "Controls longitudinal weight transfer under acceleration.",
  },
};

export const POWERTRAIN_OPTIONS: { value: Powertrain; label: string }[] = [
  { value: "ice", label: "Combustion" },
  { value: "hybrid", label: "Hybrid" },
  { value: "ev", label: "Electric" },
];

export const ASPIRATION_OPTIONS: { value: Aspiration; label: string }[] = [
  { value: "na", label: "Naturally aspirated" },
  { value: "forced", label: "Turbo / supercharged" },
  { value: "electric", label: "Electric motor" },
];

export const DRIVETRAIN_OPTIONS: { value: Drivetrain; label: string }[] = [
  { value: "FWD", label: "Front-wheel drive" },
  { value: "RWD", label: "Rear-wheel drive" },
  { value: "AWD", label: "All-wheel drive" },
  { value: "4WD", label: "Four-wheel drive" },
];

export const TRANSMISSION_OPTIONS: { value: TransmissionType; label: string }[] = [
  { value: "automatic", label: "Automatic (torque converter)" },
  { value: "dct", label: "Dual-clutch / automated manual" },
  { value: "manual", label: "Manual" },
  { value: "cvt", label: "CVT" },
  { value: "direct", label: "Single-speed (direct drive)" },
];

export const SURFACE_OPTIONS: { value: Surface; label: string; factor: number }[] = [
  { value: "dry", label: "Dry asphalt", factor: 1 },
  { value: "prepped", label: "Prepared drag strip", factor: 1.25 },
  { value: "wet", label: "Wet asphalt", factor: 0.7 },
  { value: "gravel", label: "Gravel", factor: 0.6 },
  { value: "snow", label: "Packed snow", factor: 0.3 },
];

export const SPEC_LABEL: Record<SpecKey, string> = {
  powertrain: "Powertrain",
  aspiration: "Induction",
  drivetrain: "Drivetrain",
  transmission: "Transmission",
  gearRatios: "Gear ratios",
  ...Object.fromEntries(Object.values(NUMERIC_FIELDS).map((f) => [f.key, f.label])),
} as Record<SpecKey, string>;

export function emptyValue<T>(): SpecValue<T> {
  return { value: null, provenance: "unavailable" };
}

export function emptySpecValues(): SpecValues {
  const values = {
    powertrain: emptyValue<Powertrain>(),
    aspiration: emptyValue<Aspiration>(),
    drivetrain: emptyValue<Drivetrain>(),
    transmission: emptyValue<TransmissionType>(),
    gearRatios: emptyValue<number[]>(),
  } as SpecValues;
  for (const key of Object.keys(NUMERIC_FIELDS) as NumericSpecKey[]) {
    values[key] = emptyValue<number>();
  }
  return values;
}

/** Importance weights used for the data-quality indicator. */
export const QUALITY_WEIGHTS: Partial<Record<SpecKey, number>> = {
  peakPowerKw: 4,
  curbMassKg: 4,
  peakTorqueNm: 2,
  drivetrain: 2,
  transmission: 1,
  gearRatios: 1.5,
  finalDrive: 1,
  tireMu: 2,
  dragCoefficient: 1,
  frontalAreaM2: 1,
  drivetrainEfficiency: 1,
  peakPowerRpm: 0.5,
  peakTorqueRpm: 0.5,
  redlineRpm: 0.5,
  tireRadiusM: 0.5,
};
