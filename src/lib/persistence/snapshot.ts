// Builds saved-analysis records from computed results. Pure functions (no storage access).

import { SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveValues, modifiedDiff } from "@/lib/domain/scenario";
import type { AnalysisConfig, SpecSet, VehicleIdentity } from "@/lib/domain/types";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { ENGINE_VERSION, type AnalysisResult } from "@/lib/physics/analysis";
import { SAVED_SCHEMA_VERSION, type SavedAnalysis, type SavedMeta, type SavedOrigin, type SavedSummary } from "@/lib/persistence/schema";
import { kwToHp, type UnitSystem } from "@/lib/units";
import { vehicleLabel } from "@/lib/vehicles/normalize";

export const APP_VERSION = "2.0.0";

/** Canonical JSON: sorted keys, undefined dropped, numbers rounded to 10 significant digits so
 *  float noise from unit round-trips never makes identical inputs look different. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toPrecision(10))) : "null";
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** Two independent 32-bit FNV-1a variants, hex (64 bits). Not cryptographic: it only identifies
 *  identical configurations. */
export function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function fingerprint(config: AnalysisConfig, engineVersion: string = ENGINE_VERSION): string {
  return `${hash64(`${engineVersion}|${stableStringify(config)}`)}`;
}

export function vehicleKey(identity: Pick<VehicleIdentity, "year" | "make" | "model" | "trim" | "datasetTrimId" | "source">): string {
  return [identity.source, identity.datasetTrimId ?? "", identity.year ?? "", identity.make, identity.model, identity.trim ?? ""].join("|").toLowerCase().slice(0, 400);
}

export const newRecordId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `a${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`
    : `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

export const isHistorical = (meta: Pick<SavedMeta, "engineVersion">) => meta.engineVersion !== ENGINE_VERSION;

export function summarize(result: AnalysisResult): SavedSummary {
  const stock = effectiveValues(result.config, "stock")!;
  const mod = result.modified ? effectiveValues(result.config, "modified")! : null;
  return {
    vehicle: vehicleLabel(result.identity).slice(0, 300),
    year: result.identity.year,
    make: result.identity.make,
    model: result.identity.model,
    trim: result.identity.trim,
    scenarios: result.modified ? "compare" : "stock",
    stockPowerKw: stock.peakPowerKw.value,
    modifiedPowerKw: mod?.peakPowerKw.value ?? null,
    stockMassKg: stock.curbMassKg.value,
    modifiedMassKg: mod?.curbMassKg.value ?? null,
    stock060S: result.stock.metrics.zeroTo60S,
    modified060S: result.modified?.metrics.zeroTo60S ?? null,
    stock0100KphS: result.stock.metrics.zeroTo100KphS,
    modified0100KphS: result.modified?.metrics.zeroTo100KphS ?? null,
    changes: modifiedDiff(result.config).map((k) => SPEC_LABEL[k]).slice(0, 30),
    feasibility: { stock: result.feasibility.stock.status, modified: result.feasibility.modified?.status ?? null },
  };
}

/** Automatic title, e.g. "Stock vs Modified · +100 hp" — refreshed while the user hasn't renamed it. */
export function defaultTitle(result: AnalysisResult): string {
  if (!result.modified) return "Stock analysis";
  const s = effectiveValues(result.config, "stock")!;
  const m = effectiveValues(result.config, "modified")!;
  const parts: string[] = [];
  const dp = (m.peakPowerKw.value ?? 0) - (s.peakPowerKw.value ?? 0);
  if (Math.abs(dp) > 0.05) parts.push(`${dp > 0 ? "+" : "−"}${Math.round(Math.abs(kwToHp(dp)))} hp`);
  const dm = (m.curbMassKg.value ?? 0) - (s.curbMassKg.value ?? 0);
  if (Math.abs(dm) > 0.05) parts.push(`${dm > 0 ? "+" : "−"}${Math.round(Math.abs(dm / 0.45359237))} lb`);
  const other = modifiedDiff(result.config).filter((k) => k !== "peakPowerKw" && k !== "curbMassKg").length;
  if (other) parts.push(`${other} other change${other > 1 ? "s" : ""}`);
  return `Stock vs Modified${parts.length ? ` · ${parts.join(", ")}` : ""}`.slice(0, 120);
}

export function buildRecord(input: {
  result: AnalysisResult;
  baseline: SpecSet | null;
  units: UnitSystem;
  origin: SavedOrigin;
  title?: string;
  customTitle?: boolean;
  sourceId?: string | null;
  id?: string;
  now?: Date;
}): SavedAnalysis {
  const now = (input.now ?? new Date()).toISOString();
  return {
    schema: SAVED_SCHEMA_VERSION,
    id: input.id ?? newRecordId(),
    title: (input.title ?? defaultTitle(input.result)).slice(0, 120),
    customTitle: input.customTitle ?? false,
    origin: input.origin,
    sourceId: input.sourceId ?? null,
    createdAt: now,
    updatedAt: now,
    engineVersion: input.result.engineVersion,
    appVersion: APP_VERSION,
    fingerprint: fingerprint(input.result.config, input.result.engineVersion),
    units: input.units,
    vehicleKey: vehicleKey(input.result.identity),
    summary: summarize(input.result),
    baseline: input.baseline,
    result: input.result,
  };
}

/** Replaces the results of an existing record, keeping its identity, title (if custom) and creation date. */
export function updateRecord(existing: SavedAnalysis, result: AnalysisResult, baseline: SpecSet | null, now = new Date()): SavedAnalysis {
  return {
    ...existing,
    title: existing.customTitle ? existing.title : defaultTitle(result),
    updatedAt: now.toISOString(),
    engineVersion: result.engineVersion,
    appVersion: APP_VERSION,
    fingerprint: fingerprint(result.config, result.engineVersion),
    vehicleKey: vehicleKey(result.identity),
    summary: summarize(result),
    baseline,
    result,
  };
}

export function duplicateRecord(source: SavedAnalysis, now = new Date()): SavedAnalysis {
  const stamp = now.toISOString();
  return {
    ...structuredClone(source),
    id: newRecordId(),
    title: `Copy of ${source.title}`.slice(0, 120),
    customTitle: true,
    origin: "duplicate",
    sourceId: source.id,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export const metaOf = (r: SavedAnalysis): SavedMeta => {
  const { baseline: _b, result: _r, ...meta } = r;
  void _b;
  void _r;
  return meta;
};

/** True when the workspace holds edits worth confirming before they are discarded. */
export function hasMeaningfulEdits(config: AnalysisConfig, baseline: SpecSet | null, active: Pick<SavedMeta, "fingerprint" | "engineVersion"> | null): boolean {
  if (!config.stock) return false;
  if (active) return fingerprint(config, active.engineVersion) !== active.fingerprint;
  const conditionsChanged = stableStringify(config.conditions) !== stableStringify(DEFAULT_CONDITIONS);
  const constraints = Object.values(config.constraints ?? {}).some((c) => c && Object.keys(c).length > 0);
  const stockEdited = !baseline || stableStringify(config.stock) !== stableStringify(baseline);
  return !!config.modified || conditionsChanged || constraints || stockEdited;
}
