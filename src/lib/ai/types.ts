import type { Conditions, SpecKey, SpecSet } from "@/lib/domain/types";

export const AI_INTENTS = ["analyze_vehicle", "modify", "compare", "sensitivity", "explain", "assumptions", "clarify", "other"] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

export const AI_FIELDS = [
  "power", "torque", "mass", "payload", "dragCoefficient", "frontalArea", "drivetrainEfficiency", "tireGrip",
  "finalDrive", "shiftTime", "redline", "drivetrain", "transmission", "ambientTemperature", "elevation", "surface",
] as const;
export type AiField = (typeof AI_FIELDS)[number];

export const AI_UNITS = ["hp", "kw", "ps", "lbft", "nm", "lb", "kg", "percent", "ratio", "seconds", "rpm", "c", "f", "m", "ft", "m2", "ft2", "none"] as const;
export type AiUnit = (typeof AI_UNITS)[number];

export const AI_OPERATIONS = ["set", "change", "percent"] as const;
export type AiOperation = (typeof AI_OPERATIONS)[number];

export type ChangeTarget = "stock" | "modified" | "conditions";

export type ProposedChange = {
  id: string;
  target: ChangeTarget;
  key: SpecKey | keyof Conditions;
  /** set: absolute SI value or enum; add: SI delta; scale: multiplicative factor. */
  op: "set" | "add" | "scale";
  value: number | string;
  display: string;
  reason: string;
  /** True when the number (or option) was literally stated in the user's message. */
  statedByUser: boolean;
};

export type VehicleProposal =
  | { kind: "load"; label: string; specSet: SpecSet; note: string }
  | { kind: "choose"; label: string; note: string; candidates: { trimId: string; label: string }[] }
  | { kind: "identify"; label: string; specSet: SpecSet; note: string }
  | { kind: "not_found"; label: string; note: string };

export type Proposal = {
  id: string;
  intent: AiIntent;
  vehicle: VehicleProposal | null;
  changes: ProposedChange[];
  rejected: { text: string; reason: string }[];
  view: "stock" | "modified" | "compare" | null;
  runAfterApply: boolean;
};

export type SuggestedAction = "run_analysis" | "open_results" | "open_manual" | null;

export type AssistantErrorCode =
  | "ai_unavailable"
  | "rate_limited"
  | "quota"
  | "timeout"
  | "invalid_request"
  | "message_too_long"
  | "invalid_output"
  | "duplicate"
  | "provider_error";

export type AssistantResponse =
  | {
      ok: true;
      requestId: string;
      reply: string;
      followUpQuestion: string | null;
      proposal: Proposal | null;
      suggestedAction: SuggestedAction;
      notices: string[];
    }
  | { ok: false; requestId?: string; code: AssistantErrorCode; message: string; retryAfterS?: number };

export const AI_UNAVAILABLE_MESSAGE = "AI assistance is temporarily unavailable. Manual Setup is still ready to use.";

export const AI_LIMITS = {
  maxMessageChars: 800,
  maxHistoryTurns: 8,
  maxHistoryChars: 1500,
  maxContextChars: 14000,
  maxReplyChars: 2400,
  maxChanges: 8,
};
