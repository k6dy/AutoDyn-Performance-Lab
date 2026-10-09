// Structural schema for an AnalysisConfig crossing a trust boundary (API body, persisted state).
// Range and physics checks are done afterwards by validation.ts.

import { z } from "zod";
import { NUMERIC_KEYS } from "@/lib/domain/types";

const provenance = z.enum(["verified", "user", "estimated", "unavailable"]);
const meta = { provenance, source: z.string().max(200).optional(), note: z.string().max(300).optional(), delta: z.number().optional() };
const num = z.object({ value: z.number().nullable(), ...meta });
const str = <T extends [string, ...string[]]>(values: T) => z.object({ value: z.enum(values).nullable(), ...meta });

const numericShape = Object.fromEntries(NUMERIC_KEYS.map((k) => [k, num])) as Record<(typeof NUMERIC_KEYS)[number], typeof num>;

const valuesShape = {
  ...numericShape,
  powertrain: str(["ice", "hybrid", "ev"]),
  aspiration: str(["na", "forced", "electric"]),
  drivetrain: str(["FWD", "RWD", "AWD", "4WD"]),
  transmission: str(["automatic", "manual", "dct", "cvt", "direct"]),
  gearRatios: z.object({ value: z.array(z.number()).max(12).nullable(), ...meta }),
};

export const specValuesSchema = z.object(valuesShape).strict();

export const identitySchema = z.object({
  year: z.number().int().min(1900).max(2100).nullable(),
  make: z.string().min(1).max(60),
  model: z.string().min(1).max(80),
  trim: z.string().max(160).nullable(),
  source: z.enum(["dataset", "nhtsa", "vin", "custom"]),
  sourceDetail: z.string().max(200),
  datasetTrimId: z.string().max(40).optional(),
  engineDescription: z.string().max(200).optional(),
  bodyStyle: z.string().max(80).optional(),
  fuel: z.enum(["gas", "diesel", "electric", "other"]).optional(),
  weightEstimate: z
    .object({
      kg: z.number().positive(),
      lowKg: z.number().positive(),
      highKg: z.number().positive(),
      method: z.enum(["same-model", "model-years", "class"]),
      classId: z.string().max(20).optional(),
      basis: z.string().max(300),
    })
    .optional(),
  notes: z.array(z.string().max(400)).max(10),
});

export const specSetSchema = z.object({ identity: identitySchema, values: specValuesSchema });

export const conditionsSchema = z.object({
  ambientTempC: z.number(),
  elevationM: z.number(),
  surface: z.enum(["dry", "wet", "prepped", "gravel", "snow"]),
  rollout: z.boolean(),
});

export const configSchema = z.object({
  stock: specSetSchema.nullable(),
  modified: z.object({ overrides: z.object(valuesShape).partial().strict() }).nullable(),
  conditions: conditionsSchema,
});
