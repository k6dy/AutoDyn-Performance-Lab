// Applies a reviewed proposal to a configuration. Pure: returns a new config, never mutates.
// The UI calls this only after the user presses "Apply to simulation".

import type { Proposal, ProposedChange } from "@/lib/ai/types";
import { NUMERIC_FIELDS } from "@/lib/domain/fields";
import { effectiveValues, setModifiedValue, setStockValue } from "@/lib/domain/scenario";
import type { AnalysisConfig, Conditions, NumericSpecKey, SpecKey, SpecSet, SpecValues } from "@/lib/domain/types";

export type ChangeEvaluation = {
  change: ProposedChange;
  from: number | string | null;
  to: number | string | null;
  error: string | null;
};

function baseConfig(config: AnalysisConfig, proposal: Proposal, vehicle: SpecSet | null): AnalysisConfig {
  if (vehicle) return { stock: vehicle, modified: null, conditions: config.conditions };
  return config;
}

/** The vehicle a proposal would load, if any (a chosen trim replaces a "choose" proposal). */
export function proposalVehicle(proposal: Proposal, chosen: SpecSet | null): SpecSet | null {
  if (chosen) return chosen;
  if (proposal.vehicle?.kind === "load" || proposal.vehicle?.kind === "identify") return proposal.vehicle.specSet;
  return null;
}

function current(config: AnalysisConfig, change: ProposedChange): number | string | null {
  if (change.target === "conditions") return config.conditions[change.key as keyof Conditions] as number | string;
  const values = effectiveValues(config, change.target === "modified" && config.modified ? "modified" : "stock");
  const v = values?.[change.key as SpecKey]?.value;
  return Array.isArray(v) ? null : (v as number | string | null) ?? null;
}

export function evaluateChange(config: AnalysisConfig, change: ProposedChange, edit?: number | string): ChangeEvaluation {
  const from = current(config, change);
  if (edit !== undefined) return { change, from, to: edit, error: null };
  if (change.op === "set") return { change, from, to: change.value, error: null };
  if (typeof from !== "number") {
    return { change, from, to: null, error: "No baseline value to change. Enter the value in Manual Setup or state an absolute value." };
  }
  const to = change.op === "add" ? from + (change.value as number) : from * (change.value as number);
  return { change, from, to, error: null };
}

export function evaluateProposal(
  config: AnalysisConfig,
  proposal: Proposal,
  opts: { chosen?: SpecSet | null; edits?: Record<string, number | string> } = {},
): { base: AnalysisConfig; rows: ChangeEvaluation[] } {
  const base = baseConfig(config, proposal, proposalVehicle(proposal, opts.chosen ?? null));
  // Stock changes are evaluated first so modified changes build on the corrected baseline.
  const ordered = [...proposal.changes].sort((a, b) => (a.target === "stock" ? -1 : 0) - (b.target === "stock" ? -1 : 0));
  let working = base;
  const rows: ChangeEvaluation[] = [];
  for (const c of ordered) {
    const row = evaluateChange(working, c, opts.edits?.[c.id]);
    rows.push(row);
    if (!row.error && row.to !== null) working = applyOne(working, c, row.to);
  }
  return { base, rows: proposal.changes.map((c) => rows.find((r) => r.change.id === c.id)!) };
}

function applyOne(config: AnalysisConfig, change: ProposedChange, to: number | string): AnalysisConfig {
  if (change.target === "conditions") {
    return { ...config, conditions: { ...config.conditions, [change.key]: to } };
  }
  if (!config.stock) return config;
  const key = change.key as SpecKey;
  const isNumeric = key in NUMERIC_FIELDS;
  let value = to;
  if (isNumeric && typeof value === "number" && NUMERIC_FIELDS[key as NumericSpecKey].integer) value = Math.round(value);
  const specValue = {
    value,
    provenance: "user" as const,
    source: change.target === "modified" ? "User-provided assumption (AI Build Assistant)" : "User-provided (AI Build Assistant)",
    note: change.reason || undefined,
  } as SpecValues[typeof key];
  if (change.target === "stock") return { ...config, stock: setStockValue(config.stock, key, specValue) };
  const withModified = config.modified ? config : { ...config, modified: { overrides: {} } };
  return setModifiedValue(withModified, key, specValue);
}

export function applyProposal(
  config: AnalysisConfig,
  proposal: Proposal,
  selection: { selected: Record<string, boolean>; edits?: Record<string, number | string>; chosen?: SpecSet | null },
): { config: AnalysisConfig; applied: string[]; skipped: { id: string; reason: string }[] } {
  const { base, rows } = evaluateProposal(config, proposal, { chosen: selection.chosen, edits: selection.edits });
  let next = base;
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const ordered = [...rows].sort((a, b) => (a.change.target === "stock" ? -1 : 0) - (b.change.target === "stock" ? -1 : 0));
  for (const row of ordered) {
    if (!selection.selected[row.change.id]) continue;
    // Re-evaluate against the working config so relative changes stack correctly.
    const evald = evaluateChange(next, row.change, selection.edits?.[row.change.id]);
    if (evald.error || evald.to === null) {
      skipped.push({ id: row.change.id, reason: evald.error ?? "No value" });
      continue;
    }
    next = applyOne(next, row.change, evald.to);
    applied.push(row.change.id);
  }
  if (proposal.view && proposal.view !== "stock" && !next.modified && proposal.changes.some((c) => c.target === "modified")) {
    next = { ...next, modified: { overrides: {} } };
  }
  return { config: next, applied, skipped };
}
