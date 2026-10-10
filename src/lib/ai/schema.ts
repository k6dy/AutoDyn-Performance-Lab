import { z } from "zod";
import { AI_FIELDS, AI_INTENTS, AI_LIMITS, AI_OPERATIONS, AI_UNITS } from "@/lib/ai/types";

const shortText = (max: number) => z.string().max(max);

/** Compact, display-ready context the client sends with each message. Bounded and validated. */
export const contextSchema = z
  .object({
    vehicle: z
      .object({
        label: shortText(160),
        year: z.number().int().min(1900).max(2100).nullable(),
        make: shortText(60),
        model: shortText(80),
        trim: shortText(120).nullable(),
        source: z.enum(["dataset", "nhtsa", "vin", "custom"]),
        sourceDetail: shortText(200),
      })
      .nullable(),
    stockSpecs: z.array(z.object({ field: shortText(60), value: shortText(80), provenance: z.enum(["verified", "user", "estimated", "unavailable"]) })).max(30),
    modifiedChanges: z.array(z.object({ field: shortText(60), stock: shortText(80), modified: shortText(80) })).max(30).nullable(),
    conditions: z.object({ temperature: shortText(30), elevation: shortText(30), surface: shortText(30) }),
    units: z.enum(["imperial", "metric"]),
    results: z
      .object({
        stale: z.boolean(),
        metrics: z.array(z.object({ metric: shortText(60), stock: shortText(40), modified: shortText(40).nullable(), difference: shortText(40).nullable() })).max(20),
        findings: z.array(shortText(500)).max(14),
        sensitivity: z.array(shortText(160)).max(10),
        estimatedInputs: z.array(shortText(160)).max(20),
        feasibility: z.array(shortText(700)).max(12).optional(),
        dataQuality: shortText(80),
      })
      .nullable(),
  })
  .strict();

export type AssistantContext = z.infer<typeof contextSchema>;

export const requestSchema = z
  .object({
    requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    message: z.string().trim().min(1).max(AI_LIMITS.maxMessageChars),
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(AI_LIMITS.maxHistoryChars) }))
      .max(AI_LIMITS.maxHistoryTurns)
      .refine((h) => h.reduce((n, m) => n + m.text.length, 0) <= AI_LIMITS.maxHistoryTotalChars, "history too long"),
    context: contextSchema,
    /** User asked for a detailed explanation rather than the concise default. */
    detail: z.boolean().optional(),
  })
  .strict();

export type AssistantRequest = z.infer<typeof requestSchema>;

// ---- Model output -----------------------------------------------------------------------------

export const modelOutputSchema = z.object({
  intent: z.enum(AI_INTENTS),
  reply: z.string().max(4000),
  vehicle: z.object({
    mentioned: z.boolean(),
    year: z.number().int().nullable(),
    make: z.string().max(60).nullable(),
    model: z.string().max(80).nullable(),
    trim: z.string().max(120).nullable(),
  }),
  useCurrentVehicle: z.boolean(),
  changes: z
    .array(
      z.object({
        scenario: z.enum(["stock", "modified"]),
        field: z.enum(AI_FIELDS),
        operation: z.enum(AI_OPERATIONS),
        value: z.number(),
        unit: z.enum(AI_UNITS),
        option: z.string().max(40),
        reason: z.string().max(200),
      }),
    )
    .max(12),
  view: z.enum(["none", "stock", "modified", "compare"]),
  runSimulation: z.boolean(),
  followUpQuestion: z.string().max(300).nullable(),
});

export type ModelOutput = z.infer<typeof modelOutputSchema>;

/** JSON Schema passed to Gemini structured output (subset supported by the API). */
export const modelOutputJsonSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: [...AI_INTENTS], description: "What the user wants. general = automotive knowledge question that needs no simulation; other = outside automotive scope." },
    reply: { type: "string", description: "Concise plain-text answer (no markdown tables, no HTML)." },
    vehicle: {
      type: "object",
      description: "Vehicle the user explicitly named in this message. mentioned=false if none or if they mean the current vehicle.",
      properties: {
        mentioned: { type: "boolean" },
        year: { type: ["integer", "null"] },
        make: { type: ["string", "null"] },
        model: { type: ["string", "null"] },
        trim: { type: ["string", "null"] },
      },
      required: ["mentioned", "year", "make", "model", "trim"],
    },
    useCurrentVehicle: { type: "boolean", description: "True if the request refers to the vehicle already in CONTEXT." },
    changes: {
      type: "array",
      maxItems: 12,
      description: "Parameter changes the user explicitly asked for. Never include specification values from memory.",
      items: {
        type: "object",
        properties: {
          scenario: { type: "string", enum: ["stock", "modified"] },
          field: { type: "string", enum: [...AI_FIELDS] },
          operation: { type: "string", enum: [...AI_OPERATIONS], description: "set = absolute value; change = signed delta; percent = signed percent change" },
          value: { type: "number", description: "Number exactly as the user stated it (negative for reductions). 0 for option fields." },
          unit: { type: "string", enum: [...AI_UNITS] },
          option: { type: "string", description: "For drivetrain (FWD/RWD/AWD/4WD), transmission (automatic/manual/dct/cvt/direct) or surface (dry/wet/prepped/gravel/snow); otherwise empty." },
          reason: { type: "string", description: "Short quote or paraphrase of the user's request." },
        },
        required: ["scenario", "field", "operation", "value", "unit", "option", "reason"],
      },
    },
    view: { type: "string", enum: ["none", "stock", "modified", "compare"] },
    runSimulation: { type: "boolean", description: "True if the user wants results after applying." },
    followUpQuestion: { type: ["string", "null"], description: "One concise question when the request is ambiguous; otherwise null." },
  },
  required: ["intent", "reply", "vehicle", "useCurrentVehicle", "changes", "view", "runSimulation", "followUpQuestion"],
} as const;
