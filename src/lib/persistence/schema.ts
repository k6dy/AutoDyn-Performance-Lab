// Saved-analysis records and their validation. Anything read back from browser storage or an
// imported file is untrusted: it is parsed against these schemas (finite numbers, bounded strings
// and arrays, known enums) before it can reach the UI. Nothing is ever rendered as HTML.

import { z } from "zod";
import { configSchema, conditionsSchema, identitySchema, specSetSchema } from "@/lib/domain/configSchema";
import type { SpecSet } from "@/lib/domain/types";
import type { FeasibilityStatus } from "@/lib/feasibility/types";
import type { AnalysisResult } from "@/lib/physics/analysis";
import type { UnitSystem } from "@/lib/units";

/** Bumped only when the stored record layout changes (not when the physics engine changes). */
export const SAVED_SCHEMA_VERSION = 1;

export type SavedOrigin = "auto" | "saved_as" | "duplicate" | "import" | "recalculated";

export type SavedSummary = {
  vehicle: string;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  scenarios: "stock" | "compare";
  stockPowerKw: number | null;
  modifiedPowerKw: number | null;
  stockMassKg: number | null;
  modifiedMassKg: number | null;
  stock060S: number | null;
  modified060S: number | null;
  stock0100KphS: number | null;
  modified0100KphS: number | null;
  /** Labels of the inputs the Modified scenario changes. */
  changes: string[];
  feasibility: { stock: FeasibilityStatus; modified: FeasibilityStatus | null };
};

/** Lightweight part of a record: everything the Saved Analyses list needs. */
export type SavedMeta = {
  schema: number;
  id: string;
  title: string;
  /** True once the user named it; automatic titles are refreshed when the analysis updates. */
  customTitle: boolean;
  origin: SavedOrigin;
  /** Record this one was duplicated / recalculated from. */
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Physics engine that produced the stored results. */
  engineVersion: string;
  appVersion: string;
  /** Hash of the configuration (SI) plus engine version; identical runs share it. */
  fingerprint: string;
  /** Display units when saved (all stored numbers are SI). */
  units: UnitSystem;
  /** Identity key, used to tell whether a rerun is still the same vehicle. */
  vehicleKey: string;
  summary: SavedSummary;
};

/** Heavy part: exact inputs and computed results, including chart data. */
export type SavedPayload = { id: string; baseline: SpecSet | null; result: AnalysisResult };

export type SavedAnalysis = SavedMeta & { baseline: SpecSet | null; result: AnalysisResult };

// ---- Schemas ----------------------------------------------------------------------------------

const text = (max: number) => z.string().max(max);
const num = z.number(); // zod rejects NaN and ±Infinity
const nnum = num.nullable();
const iso = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");
const provenance = z.enum(["verified", "user", "estimated", "unavailable"]);
const feasibilityStatus = z.enum(["feasible", "questionable", "non_feasible", "insufficient_data"]);
const specKeyLike = text(40);

const curveSchema = z.object({
  peakPowerW: num,
  peakTorqueNm: num,
  peakPowerRpm: num,
  peakTorqueRpm: num,
  redlineRpm: num,
  idleRpm: num,
  shape: z.enum(["plateau", "linear", "electric"]),
});

const resolvedInputsSchema = z.object({
  powertrain: z.enum(["ice", "hybrid", "ev"]),
  aspiration: z.enum(["na", "forced", "electric"]),
  drivetrain: z.enum(["FWD", "RWD", "AWD", "4WD"]),
  transmission: z.enum(["automatic", "manual", "dct", "cvt", "direct"]),
  curve: curveSchema,
  gearRatios: z.array(num).min(1).max(12),
  finalDrive: num,
  shiftTimeS: num,
  launchRpm: num,
  torqueConverter: z.boolean(),
  curbMassKg: num,
  payloadKg: num,
  massKg: num,
  tireRadiusM: num,
  dragCoefficient: num,
  frontalAreaM2: num,
  drivetrainEfficiency: num,
  rollingResistance: num,
  frontWeightFraction: num,
  cgHeightRatio: num,
  tireMu: num,
  surfaceFactor: num,
  airDensity: num,
  powerFactor: num,
});

const metricsSchema = z.object({
  zeroTo60S: nnum,
  zeroTo100KphS: nnum,
  zeroTo100MphS: nnum,
  quarterMileS: nnum,
  quarterMileTrapMs: nnum,
  fiftyToSeventyS: nnum,
  topSpeedMs: nnum,
  topSpeedLimitedBy: z.enum(["drag", "redline"]).nullable(),
  peakAccelG: num,
  tractionShareTo60: nnum,
  shiftsTo60: num,
});

const sampleSchema = z.object({
  t: num,
  v: num,
  a: num,
  x: num,
  gear: num,
  rpm: num,
  limit: z.enum(["traction", "power", "shift", "limiter"]),
  wheelPowerKw: num,
});

const scenarioResultSchema = z.object({
  scenario: z.enum(["stock", "modified"]),
  inputs: resolvedInputsSchema,
  estimates: z.array(z.object({ key: specKeyLike, value: z.union([num, text(40), z.array(num).max(12)]), reason: text(300) })).max(40),
  provenance: z.record(specKeyLike, provenance),
  metrics: metricsSchema,
  range: z.object({ conservative: metricsSchema, optimistic: metricsSchema }),
  samples: z.array(sampleSchema).max(3000),
  curve: z.array(z.object({ rpm: num, torqueNm: num, powerKw: num })).max(400),
  sensitivity: z
    .array(
      z.object({
        id: text(40),
        label: text(80),
        change: text(80),
        favorableLabel: text(80).optional(),
        unfavorableLabel: text(80).optional(),
        favorable060: nnum,
        unfavorable060: nnum,
        favorableEt: nnum,
        unfavorableEt: nnum,
        note: text(400).nullable().optional(),
      }),
    )
    .max(20),
  massSweep: z.array(z.object({ deltaPct: num, massKg: num, zeroTo60S: nnum, quarterMileS: nnum })).max(40),
  quality: z.object({
    score: num,
    level: z.enum(["High", "Moderate", "Low"]),
    counts: z.object({ verified: num, user: num, estimated: num, unavailable: num }),
  }),
  powerToWeightWkg: num,
});

const checkSchema = z.object({
  id: text(60),
  category: z.enum(["claims", "mechanical", "traction", "data", "powertrain", "mass", "aero", "acceleration", "model"]),
  label: text(120),
  outcome: z.enum(["pass", "caution", "violation", "not_assessed"]),
  detail: text(1200),
  values: z.array(z.object({ label: text(120), value: text(160) })).max(20).optional(),
  suggestion: text(600).optional(),
});

const assessmentSchema = z.object({
  scenario: z.enum(["stock", "modified"]),
  status: feasibilityStatus,
  headline: text(200),
  primaryReason: text(1200),
  checks: z.array(checkSchema).max(40),
  inputs: z.array(z.object({ label: text(120), value: text(160), provenance })).max(40),
  assumptions: z.array(text(600)).max(40),
  missing: z.array(text(300)).max(40),
  suggestions: z.array(text(600)).max(40),
  engineVersion: text(60),
});

export const analysisResultSchema = z.object({
  id: text(80),
  createdAt: iso,
  engineVersion: text(60),
  identity: identitySchema,
  conditions: conditionsSchema,
  config: configSchema,
  stock: scenarioResultSchema,
  modified: scenarioResultSchema.nullable(),
  attribution: z
    .array(z.object({ group: text(40), label: text(80), keys: z.array(specKeyLike).max(30), delta060: nnum, deltaEt: nnum, deltaTrapMs: nnum }))
    .max(10)
    .nullable(),
  feasibility: z.object({ stock: assessmentSchema, modified: assessmentSchema.nullable() }),
});

const summarySchema = z.object({
  vehicle: text(300),
  year: z.number().int().min(1900).max(2100).nullable(),
  make: text(60),
  model: text(80),
  trim: text(160).nullable(),
  scenarios: z.enum(["stock", "compare"]),
  stockPowerKw: nnum,
  modifiedPowerKw: nnum,
  stockMassKg: nnum,
  modifiedMassKg: nnum,
  stock060S: nnum,
  modified060S: nnum,
  stock0100KphS: nnum,
  modified0100KphS: nnum,
  changes: z.array(text(80)).max(30),
  feasibility: z.object({ stock: feasibilityStatus, modified: feasibilityStatus.nullable() }),
});

export const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export const savedMetaSchema = z.object({
  schema: z.literal(SAVED_SCHEMA_VERSION),
  id: z.string().regex(ID_PATTERN),
  title: text(120).min(1),
  customTitle: z.boolean(),
  origin: z.enum(["auto", "saved_as", "duplicate", "import", "recalculated"]),
  sourceId: z.string().regex(ID_PATTERN).nullable(),
  createdAt: iso,
  updatedAt: iso,
  engineVersion: text(60).min(1),
  appVersion: text(40),
  fingerprint: text(80).min(1),
  units: z.enum(["imperial", "metric"]),
  vehicleKey: text(400),
  summary: summarySchema,
});

export const savedPayloadSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  baseline: specSetSchema.nullable(),
  result: analysisResultSchema,
});

export const savedAnalysisSchema = savedMetaSchema.extend({ baseline: specSetSchema.nullable(), result: analysisResultSchema });

export function parseMeta(raw: unknown): SavedMeta | null {
  const r = savedMetaSchema.safeParse(raw);
  return r.success ? (r.data as SavedMeta) : null;
}

export function parseSaved(raw: unknown): { ok: true; record: SavedAnalysis } | { ok: false; error: string } {
  const r = savedAnalysisSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    return { ok: false, error: issue ? `${issue.path.join(".") || "record"}: ${issue.message}` : "invalid record" };
  }
  return { ok: true, record: r.data as unknown as SavedAnalysis };
}
