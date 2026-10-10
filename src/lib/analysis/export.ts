import { explainAnalysis } from "@/lib/analysis/explain";
import { metricRows, rowDelta } from "@/lib/analysis/metrics";
import { NUMERIC_FIELDS, SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveValues } from "@/lib/domain/scenario";
import type { NumericSpecKey, SpecKey, SpecValues } from "@/lib/domain/types";
import { SPEC_KEYS } from "@/lib/domain/types";
import type { AnalysisResult } from "@/lib/physics/analysis";
import { toDisplay, unitLabel, type UnitSystem } from "@/lib/units";
import { vehicleLabel } from "@/lib/vehicles/normalize";

function displayValue(key: SpecKey, values: SpecValues, units: UnitSystem, estimate?: unknown): { value: string; unit: string } {
  const v = values[key].value ?? (estimate as SpecValues[SpecKey]["value"] | undefined) ?? null;
  if (v == null) return { value: "", unit: "" };
  if (key in NUMERIC_FIELDS) {
    const def = NUMERIC_FIELDS[key as NumericSpecKey];
    const d = toDisplay(def.quantity, v as number, units);
    return { value: d.toFixed(def.quantity === "fraction" ? 1 : Math.max(def.digits, 2)), unit: unitLabel(def.quantity, units) };
  }
  return { value: Array.isArray(v) ? v.join(" / ") : String(v), unit: "" };
}

export function buildJsonReport(result: AnalysisResult, units: UnitSystem) {
  const { findings, limitations } = explainAnalysis(result);
  const scenario = (id: "stock" | "modified") => {
    const r = id === "stock" ? result.stock : result.modified;
    if (!r) return null;
    const values = effectiveValues(result.config, id)!;
    return {
      inputs: Object.fromEntries(
        SPEC_KEYS.map((k) => [k, { value: values[k].value, unitSI: k in NUMERIC_FIELDS ? NUMERIC_FIELDS[k as NumericSpecKey].quantity : null, provenance: r.provenance[k] ?? values[k].provenance, source: values[k].source ?? null, note: values[k].note ?? null }]),
      ),
      estimatesUsed: r.estimates,
      resolvedInputsSI: r.inputs,
      metricsSI: r.metrics,
      uncertaintyRangeSI: r.range,
      dataQuality: r.quality,
      sensitivity: r.sensitivity,
      massSweep: r.massSweep,
      speedTrace: r.samples.filter((_, i) => i % 2 === 0).map((s) => ({ t: +s.t.toFixed(2), speedMs: +s.v.toFixed(3), accelMs2: +s.a.toFixed(3), distanceM: +s.x.toFixed(2), gear: s.gear, rpm: s.rpm, limit: s.limit })),
    };
  };
  return {
    app: "AutoDyn Performance Lab",
    engineVersion: result.engineVersion,
    analysisId: result.id,
    generatedAt: result.createdAt,
    vehicle: { label: vehicleLabel(result.identity), ...result.identity },
    conditions: result.conditions,
    displayUnits: units,
    scenarios: { stock: scenario("stock"), modified: scenario("modified") },
    comparison: metricRows(result, units).map((row) => ({ ...row, delta: rowDelta(row) })),
    attribution: result.attribution,
    feasibility: result.feasibility,
    colorLegend: { stock: "#79A7FF", modified: "#E87942", feasible: "#50C49A", questionable: "#E9B35B", nonFeasible: "#E45B70", insufficientData: "#9299A3" },
    findings,
    limitations,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // Neutralize spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");

export function buildCsvReport(result: AnalysisResult, units: UnitSystem) {
  const lines: string[] = [];
  const fmt = (v: number | null, d: number) => (v == null ? "" : v.toFixed(d));
  lines.push(csvLine(["AutoDyn analysis", vehicleLabel(result.identity), result.createdAt, result.engineVersion]));
  lines.push("");
  lines.push(csvLine(["Metric", "Unit", "Stock", "Stock low", "Stock high", "Modified", "Modified low", "Modified high", "Difference", "Difference %"]));
  for (const row of metricRows(result, units)) {
    const d = rowDelta(row);
    lines.push(
      csvLine([
        row.label, row.unit,
        fmt(row.stock, row.digits), fmt(row.stockRange?.[0] ?? null, row.digits), fmt(row.stockRange?.[1] ?? null, row.digits),
        fmt(row.modified, row.digits), fmt(row.modifiedRange?.[0] ?? null, row.digits), fmt(row.modifiedRange?.[1] ?? null, row.digits),
        d ? d.abs.toFixed(row.digits) : "", d?.rel != null ? d.rel.toFixed(1) : "",
      ]),
    );
  }
  lines.push("");
  lines.push(csvLine(["Input", "Unit", "Stock value", "Stock provenance", "Stock source", "Modified value", "Modified provenance"]));
  const sv = effectiveValues(result.config, "stock")!;
  const mv = result.modified ? effectiveValues(result.config, "modified")! : null;
  const est = (r: typeof result.stock | null, k: SpecKey) => r?.estimates.find((e) => e.key === k)?.value;
  for (const k of SPEC_KEYS) {
    const a = displayValue(k, sv, units, est(result.stock, k));
    const b = mv ? displayValue(k, mv, units, est(result.modified, k)) : null;
    lines.push(
      csvLine([
        SPEC_LABEL[k], a.unit || b?.unit || "",
        a.value || "unavailable", result.stock.provenance[k] ?? sv[k].provenance, sv[k].source ?? "",
        b ? b.value || "unavailable" : "", mv ? result.modified!.provenance[k] ?? mv[k].provenance : "",
      ]),
    );
  }
  lines.push("");
  lines.push(csvLine(["Feasibility", "Scenario", "Status", "Constraint", "Outcome", "Detail"]));
  for (const a of [result.feasibility.stock, result.feasibility.modified]) {
    if (!a) continue;
    lines.push(csvLine(["Feasibility", a.scenario, a.headline, "Primary reason", "", a.primaryReason]));
    for (const c of a.checks) lines.push(csvLine(["Constraint", a.scenario, "", c.label, c.outcome, c.detail]));
  }
  lines.push("");
  lines.push(csvLine(["Conditions", `${result.conditions.ambientTempC} °C`, `${result.conditions.elevationM} m`, result.conditions.surface, result.conditions.rollout ? "1-ft rollout" : "no rollout"]));
  return lines.join("\r\n");
}

export function buildTraceCsv(result: AnalysisResult, units: UnitSystem) {
  const speedUnit = unitLabel("speed", units);
  const lines = [csvLine(["Scenario", "Time (s)", `Speed (${speedUnit})`, "Acceleration (g)", `Distance (${unitLabel("distance", units)})`, "Gear", "Engine rpm", "Limit"])];
  for (const r of [result.stock, result.modified]) {
    if (!r) continue;
    for (const s of r.samples) {
      lines.push(csvLine([r.scenario, s.t.toFixed(2), toDisplay("speed", s.v, units).toFixed(2), (s.a / 9.80665).toFixed(3), toDisplay("distance", s.x, units).toFixed(1), s.gear, s.rpm, s.limit]));
    }
  }
  return lines.join("\r\n");
}
