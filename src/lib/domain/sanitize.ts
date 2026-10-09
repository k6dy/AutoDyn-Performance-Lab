// Restored browser state is untrusted: values saved by an earlier session (or an earlier build)
// that are physically impossible are reset instead of being resurrected on every visit.

import { NUMERIC_FIELDS, SPEC_LABEL } from "@/lib/domain/fields";
import { DEFAULT_CONDITIONS, NUMERIC_KEYS, type AnalysisConfig, type SpecSet, type SpecValue } from "@/lib/domain/types";
import { effectiveValues } from "@/lib/domain/scenario";
import { validateConditions } from "@/lib/domain/validation";

const invalid = (key: (typeof NUMERIC_KEYS)[number], v: SpecValue<number> | undefined) => {
  const x = v?.value;
  if (x == null) return false;
  const def = NUMERIC_FIELDS[key];
  return !Number.isFinite(x) || x < def.hard[0] || x > def.hard[1];
};

export function sanitizeRestored(config: AnalysisConfig, baseline: SpecSet | null): { config: AnalysisConfig; fixed: string[] } {
  const fixed: string[] = [];
  if (!config.stock) return { config, fixed };
  const stockValues = { ...config.stock.values };
  for (const key of NUMERIC_KEYS) {
    if (!invalid(key, stockValues[key])) continue;
    const fallback = baseline?.values[key];
    stockValues[key] = fallback && !invalid(key, fallback) ? fallback : { value: null, provenance: "unavailable" };
    fixed.push(`Stock ${SPEC_LABEL[key].toLowerCase()}`);
  }
  let next: AnalysisConfig = { ...config, stock: { ...config.stock, values: stockValues } };

  if (next.modified) {
    const overrides = { ...next.modified.overrides };
    const mod = effectiveValues(next, "modified")!;
    for (const key of NUMERIC_KEYS) {
      if (overrides[key] && invalid(key, mod[key])) {
        delete overrides[key];
        fixed.push(`Modified ${SPEC_LABEL[key].toLowerCase()}`);
      }
    }
    next = { ...next, modified: { overrides } };
  }

  const badConditions = validateConditions(next.conditions).filter((i) => i.severity === "error");
  if (badConditions.length) {
    next = { ...next, conditions: { ...DEFAULT_CONDITIONS, rollout: next.conditions.rollout } };
    fixed.push("conditions");
  }
  return { config: next, fixed };
}
