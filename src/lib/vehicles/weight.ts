// Curb-weight estimates for vehicles whose source has no published weight. An estimate is only
// *offered*; it is applied when the user accepts it, and it is always labeled "estimated".

import classData from "@/data/weight-classes.json";
import type { WeightEstimate } from "@/lib/domain/types";
import type { DatasetTrim } from "@/lib/vehicles/normalize";
import { lbToKg } from "@/lib/units";

export type VehicleClassId = "car-small" | "car-mid" | "car-large" | "suv-small" | "suv-mid" | "suv-large" | "pickup" | "van";

export const VEHICLE_CLASSES: { id: VehicleClassId; label: string }[] = [
  { id: "car-small", label: "Compact car" },
  { id: "car-mid", label: "Midsize car" },
  { id: "car-large", label: "Full-size car" },
  { id: "suv-small", label: "Small SUV / crossover" },
  { id: "suv-mid", label: "Midsize SUV" },
  { id: "suv-large", label: "Large SUV" },
  { id: "pickup", label: "Pickup truck" },
  { id: "van", label: "Van / minivan" },
];

type ClassStats = { n: number; p25Lb: number; medianLb: number; p75Lb: number };
const STATS = (classData as { classes: Record<VehicleClassId, ClassStats> }).classes;

/** Must match classify() in scripts/build-vehicle-index.mjs. */
export function classifyVehicle(body?: string | null, lengthIn?: number | null): VehicleClassId | null {
  const b = String(body ?? "").toLowerCase();
  if (/truck|pickup/.test(b)) return "pickup";
  if (/van/.test(b)) return "van";
  if (/suv|sport utility|crossover/.test(b)) return lengthIn == null ? "suv-mid" : lengthIn < 182 ? "suv-small" : lengthIn < 196 ? "suv-mid" : "suv-large";
  if (/sedan|saloon|hatch|wagon|coupe|convertible|cabrio/.test(b)) return lengthIn == null ? "car-mid" : lengthIn < 180 ? "car-small" : lengthIn < 194 ? "car-mid" : "car-large";
  return null;
}

const fmt = (lb: number) => `${Math.round(lb).toLocaleString("en-US")} lb`;

export function estimateForClass(id: VehicleClassId): WeightEstimate {
  const s = STATS[id];
  const label = VEHICLE_CLASSES.find((c) => c.id === id)!.label.toLowerCase();
  return {
    kg: lbToKg(s.medianLb),
    lowKg: lbToKg(s.p25Lb),
    highKg: lbToKg(s.p75Lb),
    method: "class",
    classId: id,
    basis: `Typical ${label}: median of ${s.n.toLocaleString("en-US")} dataset vehicles (middle half ${fmt(s.p25Lb)}–${fmt(s.p75Lb)}).`,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Best available estimate for a dataset trim without a published weight:
 * 1) other trims of the same year/make/model, 2) the same model in nearby years, 3) vehicle class.
 */
export function estimateWeightFromDataset(trim: DatasetTrim, all: DatasetTrim[]): WeightEstimate | null {
  const same = (t: DatasetTrim) => t.make === trim.make && t.model === trim.model && t.curbWeightLb != null && t.id !== trim.id;
  const prefer = (pool: DatasetTrim[]) => {
    const closer = pool.filter((t) => t.drive === trim.drive && t.body === trim.body);
    return closer.length >= 1 ? closer : pool;
  };
  const build = (pool: DatasetTrim[], method: WeightEstimate["method"], basis: (lo: number, hi: number) => string): WeightEstimate => {
    const ws = pool.map((t) => t.curbWeightLb!);
    const lo = Math.min(...ws);
    const hi = Math.max(...ws);
    return { kg: lbToKg(median(ws)), lowKg: lbToKg(lo), highKg: lbToKg(hi), method, basis: basis(lo, hi) };
  };

  const sameYear = prefer(all.filter((t) => same(t) && t.year === trim.year));
  if (sameYear.length) {
    return build(sameYear, "same-model", (lo, hi) =>
      `Median of ${sameYear.length} other ${trim.year} ${trim.make} ${trim.model} trim${sameYear.length > 1 ? "s" : ""} with a published weight${lo !== hi ? ` (${fmt(lo)}–${fmt(hi)})` : ""}.`,
    );
  }
  const nearby = prefer(all.filter((t) => same(t) && Math.abs(t.year - trim.year) <= 2));
  if (nearby.length) {
    const years = Array.from(new Set(nearby.map((t) => t.year))).sort();
    return build(nearby, "model-years", (lo, hi) =>
      `Median of ${nearby.length} ${trim.make} ${trim.model} trims from ${years[0]}${years.length > 1 ? `–${years.at(-1)}` : ""} with a published weight${lo !== hi ? ` (${fmt(lo)}–${fmt(hi)})` : ""}.`,
    );
  }
  const cls = classifyVehicle(trim.body, trim.lengthIn);
  return cls ? estimateForClass(cls) : null;
}
