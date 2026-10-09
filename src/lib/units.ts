// Unit conversions. All physics runs in SI; these helpers only exist at the edges
// (data import, UI display, AI-proposed values).

export const W_PER_HP = 745.699872; // mechanical (SAE) horsepower
export const W_PER_PS = 735.49875; // metric horsepower
export const NM_PER_LBFT = 1.3558179483;
export const KG_PER_LB = 0.45359237;
export const M_PER_IN = 0.0254;
export const M_PER_FT = 0.3048;
export const MS_PER_MPH = 0.44704;
export const MS_PER_KPH = 1 / 3.6;
export const M2_PER_FT2 = M_PER_FT * M_PER_FT;
export const QUARTER_MILE_M = 402.336;
export const G = 9.80665;

export const hpToKw = (hp: number) => (hp * W_PER_HP) / 1000;
export const kwToHp = (kw: number) => (kw * 1000) / W_PER_HP;
export const psToKw = (ps: number) => (ps * W_PER_PS) / 1000;
export const lbftToNm = (lbft: number) => lbft * NM_PER_LBFT;
export const nmToLbft = (nm: number) => nm / NM_PER_LBFT;
export const lbToKg = (lb: number) => lb * KG_PER_LB;
export const kgToLb = (kg: number) => kg / KG_PER_LB;
export const mphToMs = (mph: number) => mph * MS_PER_MPH;
export const msToMph = (ms: number) => ms / MS_PER_MPH;
export const kphToMs = (kph: number) => kph * MS_PER_KPH;
export const msToKph = (ms: number) => ms / MS_PER_KPH;
export const fToC = (f: number) => ((f - 32) * 5) / 9;
export const cToF = (c: number) => (c * 9) / 5 + 32;
export const ftToM = (ft: number) => ft * M_PER_FT;
export const mToFt = (m: number) => m / M_PER_FT;
export const inToM = (inch: number) => inch * M_PER_IN;
export const mToIn = (m: number) => m / M_PER_IN;
export const rpmToRadS = (rpm: number) => (rpm * 2 * Math.PI) / 60;
export const radSToRpm = (rad: number) => (rad * 60) / (2 * Math.PI);

export type UnitSystem = "imperial" | "metric";

export type Quantity =
  | "power"
  | "torque"
  | "mass"
  | "radius"
  | "area"
  | "temperature"
  | "elevation"
  | "speed"
  | "distance"
  | "fraction"
  | "rpm"
  | "ratio"
  | "time"
  | "coefficient"
  | "count";

type UnitDef = { label: string; fromSi: (v: number) => number; toSi: (v: number) => number };

const id = (v: number) => v;

export const UNITS: Record<Quantity, Record<UnitSystem, UnitDef>> = {
  power: {
    imperial: { label: "hp", fromSi: kwToHp, toSi: hpToKw },
    metric: { label: "kW", fromSi: id, toSi: id },
  },
  torque: {
    imperial: { label: "lb·ft", fromSi: nmToLbft, toSi: lbftToNm },
    metric: { label: "N·m", fromSi: id, toSi: id },
  },
  mass: {
    imperial: { label: "lb", fromSi: kgToLb, toSi: lbToKg },
    metric: { label: "kg", fromSi: id, toSi: id },
  },
  radius: {
    imperial: { label: "in", fromSi: mToIn, toSi: inToM },
    metric: { label: "mm", fromSi: (m) => m * 1000, toSi: (mm) => mm / 1000 },
  },
  area: {
    imperial: { label: "ft²", fromSi: (m2) => m2 / M2_PER_FT2, toSi: (f) => f * M2_PER_FT2 },
    metric: { label: "m²", fromSi: id, toSi: id },
  },
  temperature: {
    imperial: { label: "°F", fromSi: cToF, toSi: fToC },
    metric: { label: "°C", fromSi: id, toSi: id },
  },
  elevation: {
    imperial: { label: "ft", fromSi: mToFt, toSi: ftToM },
    metric: { label: "m", fromSi: id, toSi: id },
  },
  speed: {
    imperial: { label: "mph", fromSi: msToMph, toSi: mphToMs },
    metric: { label: "km/h", fromSi: msToKph, toSi: kphToMs },
  },
  distance: {
    imperial: { label: "ft", fromSi: mToFt, toSi: ftToM },
    metric: { label: "m", fromSi: id, toSi: id },
  },
  fraction: {
    imperial: { label: "%", fromSi: (f) => f * 100, toSi: (p) => p / 100 },
    metric: { label: "%", fromSi: (f) => f * 100, toSi: (p) => p / 100 },
  },
  rpm: {
    imperial: { label: "rpm", fromSi: id, toSi: id },
    metric: { label: "rpm", fromSi: id, toSi: id },
  },
  ratio: {
    imperial: { label: ":1", fromSi: id, toSi: id },
    metric: { label: ":1", fromSi: id, toSi: id },
  },
  time: {
    imperial: { label: "s", fromSi: id, toSi: id },
    metric: { label: "s", fromSi: id, toSi: id },
  },
  coefficient: {
    imperial: { label: "", fromSi: id, toSi: id },
    metric: { label: "", fromSi: id, toSi: id },
  },
  count: {
    imperial: { label: "", fromSi: id, toSi: id },
    metric: { label: "", fromSi: id, toSi: id },
  },
};

export function toDisplay(q: Quantity, si: number, system: UnitSystem) {
  return UNITS[q][system].fromSi(si);
}

export function fromDisplay(q: Quantity, value: number, system: UnitSystem) {
  return UNITS[q][system].toSi(value);
}

export function unitLabel(q: Quantity, system: UnitSystem) {
  return UNITS[q][system].label;
}

/** Parses a P-metric / metric tire size such as "225/45R17" or "245/40 ZR18" into rolling radius (m). */
export function tireSizeToRadiusM(size: string): number | null {
  const m = size.trim().toUpperCase().match(/^(?:P|LT)?\s*(\d{3})\s*\/\s*(\d{2})\s*Z?R?F?\s*-?\s*(\d{2}(?:\.\d)?)$/);
  if (!m) return null;
  const width = Number(m[1]);
  const aspect = Number(m[2]);
  const rim = Number(m[3]);
  if (width < 125 || width > 405 || aspect < 20 || aspect > 90 || rim < 12 || rim > 26) return null;
  const sidewallM = (width * aspect) / 100 / 1000;
  const unloaded = (rim * M_PER_IN) / 2 + sidewallM;
  // Loaded rolling radius is typically ~97% of unloaded radius.
  return unloaded * 0.97;
}

export function formatNumber(value: number, digits = 0) {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
