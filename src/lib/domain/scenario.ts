import type {
  AnalysisConfig,
  ScenarioConstraints,
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
  const out = { ...config.stock.values, ...config.modified.overrides } as SpecValues;
  // Relative overrides ("−150 lb vs stock") always follow the current stock value.
  for (const [key, o] of Object.entries(config.modified.overrides) as [SpecKey, SpecValue<unknown>][]) {
    if (o?.delta === undefined) continue;
    const base = config.stock.values[key].value;
    (out as Record<string, SpecValue<unknown>>)[key] = { ...o, value: typeof base === "number" ? base + o.delta : null };
  }
  return out;
}

export function sameValue(a: SpecValue<unknown>["value"], b: SpecValue<unknown>["value"]) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

/** Keys whose modified value differs from stock. */
export function modifiedDiff(config: AnalysisConfig): SpecKey[] {
  if (!config.stock || !config.modified) return [];
  const mod = effectiveValues(config, "modified")!;
  return SPEC_KEYS.filter((k) => config.modified!.overrides[k] !== undefined && !sameValue(mod[k].value, config.stock!.values[k].value));
}

/** Constraints that apply to a scenario: Modified inherits Stock's unless it sets its own. */
export function effectiveConstraints(config: AnalysisConfig, scenario: ScenarioId): ScenarioConstraints {
  const stock = config.constraints?.stock ?? {};
  if (scenario === "stock") return stock;
  const mod = config.constraints?.modified ?? {};
  const out: ScenarioConstraints = { ...stock };
  for (const [k, v] of Object.entries(mod)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export function setStockValue<K extends SpecKey>(stock: SpecSet, key: K, value: SpecValues[K]): SpecSet {
  return { ...stock, values: { ...stock.values, [key]: value } };
}

/** Sets a modified override; an override equal to stock is dropped so the scenario stays a clean diff. */
export function setModifiedValue<K extends SpecKey>(config: AnalysisConfig, key: K, value: SpecValues[K]): AnalysisConfig {
  if (!config.stock) return config;
  const overrides = { ...(config.modified?.overrides ?? {}) };
  const noDelta = value.delta === undefined || Math.abs(value.delta) < 1e-9;
  if (value.delta !== undefined && noDelta) {
    delete overrides[key];
  } else if (noDelta && sameValue(value.value, config.stock.values[key].value) && value.provenance === config.stock.values[key].provenance) {
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
