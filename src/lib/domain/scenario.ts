import type {
  AnalysisConfig,
  ScenarioId,
  SpecKey,
  SpecSet,
  SpecValue,
  SpecValues,
} from "@/lib/domain/types";
import { SPEC_KEYS } from "@/lib/domain/types";

/** Modified values are the stock baseline with overrides layered on top; stock is never mutated. */
export function effectiveValues(config: AnalysisConfig, scenario: ScenarioId): SpecValues | null {
  if (!config.stock) return null;
  if (scenario === "stock" || !config.modified) return config.stock.values;
  return { ...config.stock.values, ...config.modified.overrides } as SpecValues;
}

export function sameValue(a: SpecValue<unknown>["value"], b: SpecValue<unknown>["value"]) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Keys whose modified value differs from stock. */
export function modifiedDiff(config: AnalysisConfig): SpecKey[] {
  if (!config.stock || !config.modified) return [];
  return SPEC_KEYS.filter((k) => {
    const o = config.modified!.overrides[k];
    return o !== undefined && !sameValue(o.value, config.stock!.values[k].value);
  });
}

export function setStockValue<K extends SpecKey>(stock: SpecSet, key: K, value: SpecValues[K]): SpecSet {
  return { ...stock, values: { ...stock.values, [key]: value } };
}

/** Sets a modified override; an override equal to stock is dropped so the scenario stays a clean diff. */
export function setModifiedValue<K extends SpecKey>(config: AnalysisConfig, key: K, value: SpecValues[K]): AnalysisConfig {
  if (!config.stock) return config;
  const overrides = { ...(config.modified?.overrides ?? {}) };
  if (sameValue(value.value, config.stock.values[key].value) && value.provenance === config.stock.values[key].provenance) {
    delete overrides[key];
  } else {
    overrides[key] = value;
  }
  return { ...config, modified: { overrides } };
}

export function userValue<T>(value: T | null, note?: string): SpecValue<T> {
  if (value === null) return { value: null, provenance: "unavailable" };
  return { value, provenance: "user", source: "User input", note };
}
