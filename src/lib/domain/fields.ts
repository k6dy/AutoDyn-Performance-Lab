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
    help: "Maximum engine or motor output. Required — AutoDyn never guesses power.",
  },
  peakTorqueNm: {
    key: "peakTorqueNm", label: "Peak torque", quantity: "torque", section: "powertrain", tier: "basic",
    hard: [1, 20000], typical: [50, 1500], estimable: true, digits: 0,
    help: "Optional. If left blank, AutoDyn estimates it from power (labeled, low confidence).",
  },
  peakPowerRpm: {
    key: "peakPowerRpm", label: "Power peak speed", evLabel: "Base motor speed", quantity: "rpm", section: "powertrain", tier: "advanced",
    hard: [300, 30000], typical: [2500, 9500], integer: true, estimable: true, digits: 0,
    help: "Engine speed where maximum power is made.",
  },
  peakTorqueRpm: {
    key: "peakTorqueRpm", label: "Torque peak speed", quantity: "rpm", section: "powertrain", tier: "advanced",
    hard: [300, 30000], typical: [1000, 8000], integer: true, estimable: true, digits: 0,
    help: "Engine speed where maximum torque starts. Turbo engines: often 1,500–2,000 rpm.",
  },
  redlineRpm: {
    key: "redlineRpm", label: "Redline", evLabel: "Max motor speed", quantity: "rpm", section: "powertrain", tier: "advanced",
    hard: [1000, 30000], typical: [4000, 20000], integer: true, estimable: true, digits: 0,
    help: "Highest engine or motor speed; sets shift points and gearing-limited top speed.",
  },
  gearCount: {
    key: "gearCount", label: "Forward gears", quantity: "count", section: "powertrain", tier: "advanced",
    hard: [1, 12], typical: [1, 10], integer: true, estimable: true, digits: 0,
    help: "Number of forward gears.",
  },
  finalDrive: {
    key: "finalDrive", label: "Final drive ratio", evLabel: "Reduction ratio", quantity: "ratio", section: "powertrain", tier: "advanced",
    hard: [0.5, 30], typical: [2, 12], estimable: true, digits: 2,
    help: "Axle gear ratio. Higher = quicker acceleration, lower top speed in each gear.",
  },
  shiftTimeS: {
    key: "shiftTimeS", label: "Shift interruption", quantity: "time", section: "powertrain", tier: "advanced",
    hard: [0, 3], typical: [0, 0.8], estimable: true, digits: 2,
    help: "Time without drive per upshift. Dual-clutch ≈ 0.1 s, automatic ≈ 0.1–0.2 s, manual ≈ 0.3 s.",
  },
  curbMassKg: {
    key: "curbMassKg", label: "Vehicle weight (curb)", quantity: "mass", section: "vehicle", tier: "basic",
    hard: [50, 50000], typical: [700, 3500], required: true, estimable: false, digits: 0,
    help: "Curb weight: the vehicle with fluids, without occupants or cargo. Needed for every simulation.",
  },
  payloadKg: {
    key: "payloadKg", label: "Driver & cargo", quantity: "mass", section: "vehicle", tier: "basic",
    hard: [0, 5000], typical: [0, 400], estimable: true, digits: 0,
    help: "Weight added to curb weight for the run. Default: one 80 kg (176 lb) driver.",
  },
  dragCoefficient: {
    key: "dragCoefficient", label: "Drag coefficient (Cd)", quantity: "coefficient", section: "vehicle", tier: "basic",
    hard: [0.05, 2], typical: [0.2, 0.6], estimable: true, digits: 3,
    help: "How easily air flows around the body. Most cars 0.25–0.35; lower is slipperier.",
  },
  frontalAreaM2: {
    key: "frontalAreaM2", label: "Frontal area", quantity: "area", section: "vehicle", tier: "basic",
    hard: [0.3, 15], typical: [1.5, 4], estimable: true, digits: 2,
    help: "Size of the car seen from the front. Most cars 2.0–2.6 m² (22–28 ft²).",
  },
  drivetrainEfficiency: {
    key: "drivetrainEfficiency", label: "Drivetrain efficiency", quantity: "fraction", section: "vehicle", tier: "basic",
    hard: [0.3, 1], typical: [0.75, 0.97], estimable: true, digits: 0,
    help: "Share of engine power that reaches the wheels after gearbox and axle losses (enter 86 or 0.86).",
  },
  tireMu: {
    key: "tireMu", label: "Tire grip (μ)", quantity: "coefficient", section: "vehicle", tier: "basic",
    hard: [0.1, 3], typical: [0.6, 1.4], estimable: true, digits: 2,
    help: "How much grip the tires have on dry asphalt. 1.0 ≈ everyday tires; 1.1–1.2 ≈ performance tires.",
  },
  tireRadiusM: {
    key: "tireRadiusM", label: "Tire rolling radius", quantity: "radius", section: "vehicle", tier: "advanced",
    hard: [0.1, 1.5], typical: [0.26, 0.45], estimable: true, digits: 1,
    help: "Distance from wheel center to the road. Use the tire-size helper to calculate it.",
  },
  rollingResistance: {
    key: "rollingResistance", label: "Rolling resistance (Crr)", quantity: "coefficient", section: "vehicle", tier: "advanced",
    hard: [0.001, 0.2], typical: [0.006, 0.02], estimable: true, digits: 4,
    help: "Energy lost as tires roll. Typical passenger tires 0.008–0.013.",
  },
  frontWeightFraction: {
    key: "frontWeightFraction", label: "Front weight share", quantity: "fraction", section: "vehicle", tier: "advanced",
    hard: [0.2, 0.8], typical: [0.38, 0.65], estimable: true, digits: 0,
    help: "Share of weight on the front wheels. Affects launch grip for 2WD cars.",
  },
  cgHeightRatio: {
    key: "cgHeightRatio", label: "CG height ÷ wheelbase", quantity: "coefficient", section: "vehicle", tier: "advanced",
    hard: [0.05, 0.6], typical: [0.14, 0.32], estimable: true, digits: 2,
    help: "How much weight shifts rearward when accelerating. Typical cars 0.18–0.22.",
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
  { value: "dry", label: "Dry asphalt (standard)", factor: 1 },
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
