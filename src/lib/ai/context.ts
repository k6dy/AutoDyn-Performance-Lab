// Builds the compact, display-unit context sent to the assistant from the *actual* configuration
// and the *actual* computed results. The model sees nothing else about the vehicle.

import type { AssistantContext } from "@/lib/ai/schema";
import type { Proposal } from "@/lib/ai/types";
import { explainAnalysis } from "@/lib/analysis/explain";
import { metricRows, rowDelta } from "@/lib/analysis/metrics";
import { NUMERIC_FIELDS, SPEC_LABEL, SURFACE_OPTIONS } from "@/lib/domain/fields";
import { effectiveValues, modifiedDiff } from "@/lib/domain/scenario";
import type { AnalysisConfig, NumericSpecKey, SpecKey, SpecValues } from "@/lib/domain/types";
import { SPEC_KEYS } from "@/lib/domain/types";
import type { AnalysisResult } from "@/lib/physics/analysis";
import { toDisplay, unitLabel, type UnitSystem } from "@/lib/units";
import { vehicleLabel } from "@/lib/vehicles/normalize";

export function displaySpec(key: SpecKey, values: SpecValues, units: UnitSystem): string {
  const v = values[key].value;
  if (v == null) return "not set";
  if (Array.isArray(v)) return v.map((x) => x.toFixed(2)).join("/");
  if (typeof v === "string") return v;
  const def = NUMERIC_FIELDS[key as NumericSpecKey];
  const d = toDisplay(def.quantity, v, units);
  const digits = def.quantity === "fraction" ? 0 : def.digits;
  return `${d.toFixed(digits)} ${unitLabel(def.quantity, units)}`.trim();
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A proposal shown in the chat but not applied yet (nothing has been simulated for it). */
export type PendingProposal = { vehicle: string | null; needsChoice: boolean; changes: string[] };

/** The latest proposal of the open chat that is still waiting for Apply, in context form. */
export function pendingProposalOf(states: { proposal: Proposal; status: string; selected: Record<string, boolean>; chosen: unknown }[]): PendingProposal | null {
  const p = [...states].reverse().find((s) => s.status === "pending");
  if (!p) return null;
  const v = p.proposal.vehicle;
  return {
    vehicle: v ? v.label : null,
    needsChoice: v?.kind === "choose" && !p.chosen,
    changes: p.proposal.changes.filter((c) => p.selected[c.id] !== false).map((c) => `${SPEC_LABEL[c.key as SpecKey] ?? c.key} ${c.display}`),
  };
}

export function buildAssistantContext(
  config: AnalysisConfig,
  result: { analysis: AnalysisResult; stale: boolean } | null,
  units: UnitSystem,
  pending: PendingProposal | null = null,
): AssistantContext {
  const stock = config.stock;
  const values = effectiveValues(config, "stock");
  const mod = config.modified ? effectiveValues(config, "modified") : null;
  const r = result?.analysis;

  return {
    vehicle: stock
      ? {
          label: clip(vehicleLabel(stock.identity), 160),
          year: stock.identity.year,
          make: clip(stock.identity.make, 60),
          model: clip(stock.identity.model, 80),
          trim: stock.identity.trim ? clip(stock.identity.trim, 120) : null,
          source: stock.identity.source,
          sourceDetail: clip(stock.identity.sourceDetail, 200),
        }
      : null,
    stockSpecs: values
      ? SPEC_KEYS.map((k) => ({
          field: SPEC_LABEL[k],
          value: clip(displaySpec(k, values, units), 80),
          provenance: values[k].value == null ? ("unavailable" as const) : values[k].provenance,
        })).slice(0, 30)
      : [],
    modifiedChanges:
      values && mod
        ? modifiedDiff(config).map((k) => ({ field: SPEC_LABEL[k], stock: clip(displaySpec(k, values, units), 80), modified: clip(displaySpec(k, mod, units), 80) }))
        : null,
    conditions: {
      temperature: `${toDisplay("temperature", config.conditions.ambientTempC, units).toFixed(0)} ${unitLabel("temperature", units)}`,
      elevation: `${toDisplay("elevation", config.conditions.elevationM, units).toFixed(0)} ${unitLabel("elevation", units)}`,
      surface: SURFACE_OPTIONS.find((s) => s.value === config.conditions.surface)?.label ?? config.conditions.surface,
    },
    units,
    pendingProposal: pending ? { vehicle: pending.vehicle ? clip(pending.vehicle, 160) : null, needsChoice: pending.needsChoice, changes: pending.changes.slice(0, 8).map((c) => clip(c, 120)) } : null,
    results: r
      ? {
          stale: result!.stale,
          metrics: metricRows(r, units)
            .filter((row) => row.stock != null)
            .map((row) => {
              const d = rowDelta(row);
              const f = (v: number | null) => (v == null ? "n/a" : `${v.toFixed(row.digits)} ${row.unit}`.trim());
              return {
                metric: row.label,
                stock: f(row.stock),
                modified: r.modified ? f(row.modified) : null,
                difference: d ? `${d.abs >= 0 ? "+" : ""}${d.abs.toFixed(row.digits)} ${row.unit}${d.rel != null ? ` (${d.rel >= 0 ? "+" : ""}${d.rel.toFixed(1)}%)` : ""}`.trim() : null,
              };
            })
            .slice(0, 20),
          findings: explainAnalysis(r)
            .findings.map((f) => clip(`${f.title}. ${f.detail}`, 500))
            .slice(0, 14),
          sensitivity: (r.modified ?? r.stock).sensitivity
            .filter((s) => s.unfavorable060 != null)
            .map((s) => `${s.label} (${s.change}): 0–60 ${s.favorable060!.toFixed(2)} s / ${s.unfavorable060!.toFixed(2)} s`)
            .slice(0, 10),
          estimatedInputs: Array.from(new Set([...r.stock.estimates, ...(r.modified?.estimates ?? [])].filter((e) => e.key !== "launchRpm").map((e) => clip(`${SPEC_LABEL[e.key as SpecKey]}: ${e.reason}`, 160)))).slice(0, 20),
          dataQuality: `Stock ${r.stock.quality.level}${r.modified ? `, modified ${r.modified.quality.level}` : ""}`,
          feasibility: [r.feasibility.stock, r.feasibility.modified]
            .filter((a): a is NonNullable<typeof a> => !!a)
            .flatMap((a) => [
              clip(`${a.scenario === "stock" ? "Stock" : "Modified"} feasibility: ${a.headline}. ${a.primaryReason}`, 700),
              ...a.checks
                .filter((c) => c.outcome === "violation" || c.outcome === "caution")
                .slice(0, 4)
                .map((c) => clip(`${a.scenario === "stock" ? "Stock" : "Modified"} · ${c.label} (${c.outcome}): ${c.detail}`, 700)),
            ])
            .slice(0, 12),
        }
      : null,
  };
}
