import "server-only";
import index from "@/data/vehicle-index.json";
import type { SpecSet } from "@/lib/domain/types";
import { datasetTrimToSpecSet, type DatasetTrim } from "@/lib/vehicles/normalize";
import { estimateWeightFromDataset } from "@/lib/vehicles/weight";

type Index = { columns: string[]; rows: (string | number | null)[][] };

let cache: { trims: DatasetTrim[]; byId: Map<string, DatasetTrim> } | null = null;

function load() {
  if (cache) return cache;
  const { columns, rows } = index as unknown as Index;
  const trims = rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])) as unknown as DatasetTrim);
  cache = { trims, byId: new Map(trims.map((t) => [t.id, t])) };
  return cache;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const uniqSorted = (values: string[]) => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));

export function datasetYears(): number[] {
  return Array.from(new Set(load().trims.map((t) => t.year))).sort((a, b) => b - a);
}

export function datasetMakes(year: number): string[] {
  return uniqSorted(load().trims.filter((t) => t.year === year).map((t) => t.make));
}

export function datasetAllMakes(): string[] {
  return uniqSorted(load().trims.map((t) => t.make));
}

export function datasetModels(year: number, make: string): string[] {
  return uniqSorted(load().trims.filter((t) => t.year === year && eq(t.make, make)).map((t) => t.model));
}

export function datasetTrims(year: number, make: string, model: string): DatasetTrim[] {
  return load()
    .trims.filter((t) => t.year === year && eq(t.make, make) && eq(t.model, model))
    .sort((a, b) => (a.msrp ?? 0) - (b.msrp ?? 0) || String(a.trim).localeCompare(String(b.trim)));
}

export function datasetTrim(id: string): DatasetTrim | null {
  return load().byId.get(id) ?? null;
}

export function allDatasetTrims(): DatasetTrim[] {
  return load().trims;
}

/** Spec set for a trim, with a curb-weight estimate *offered* when the source has no weight. */
export function datasetSpecSet(trim: DatasetTrim): SpecSet {
  const specSet = datasetTrimToSpecSet(trim);
  if (trim.curbWeightLb == null) {
    const estimate = estimateWeightFromDataset(trim, load().trims);
    if (estimate) specSet.identity.weightEstimate = estimate;
  }
  return specSet;
}
