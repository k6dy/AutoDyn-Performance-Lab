import { metricRows, rowDelta } from "@/lib/analysis/metrics";
import type { AnalysisResult } from "@/lib/physics/analysis";
import type { UnitSystem } from "@/lib/units";
import { vehicleLabel } from "@/lib/vehicles/normalize";

/** Deterministic one-paragraph results summary built only from computed metrics. */
export function resultsSummary(result: AnalysisResult, units: UnitSystem) {
  const rows = metricRows(result, units);
  const pick = (id: string) => rows.find((r) => r.id === id)!;
  const fmt = (v: number | null, d: number, unit: string) => (v == null ? "n/a" : `${v.toFixed(d)}${unit ? ` ${unit}` : ""}`);
  const line = (id: string) => {
    const r = pick(id);
    if (!result.modified) return `${r.label} ${fmt(r.stock, r.digits, r.unit)}`;
    const d = rowDelta(r);
    const delta = d ? ` (${d.abs > 0 ? "+" : "−"}${Math.abs(d.abs).toFixed(r.digits)}${r.unit ? ` ${r.unit}` : ""})` : "";
    return `${r.label} ${fmt(r.stock, r.digits, r.unit)} → ${fmt(r.modified, r.digits, r.unit)}${delta}`;
  };
  const head = `Physics engine results for ${vehicleLabel(result.identity)}${result.modified ? ", stock → modified" : ""}:`;
  return `${head}\n- ${line("060")}\n- ${line("qm")}\n- ${line("trap")}\n- ${line("ptw")}`;
}
