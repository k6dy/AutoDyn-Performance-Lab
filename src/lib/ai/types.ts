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
  | { kind: "choose"; label: string; make: string; note: string; candidates: { trimId: string; label: string }[] }
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

/** Failures attributable to the AI provider (Gemini) or its configuration. */
export type ProviderCode =
  | "not_configured"
  | "invalid_key"
  | "model_unavailable"
  | "quota"
  | "timeout"
  | "network"
  | "server_error"
  | "request_rejected"
  | "invalid_output";

export type AssistantErrorCode = ProviderCode | "rate_limited" | "invalid_request" | "message_too_long" | "duplicate";

export type ProviderHealth = {
  status: "ok" | ProviderCode;
  model: string;
  checkedAt: string;
  latencyMs: number | null;
  source: "probe" | "request";
};

export type DeploymentInfo = { environment: string; branch: string | null; commit: string | null };

export type AssistantStatus = {
  configured: boolean;
  model: string | null;
  deployment: DeploymentInfo;
  provider: ProviderHealth | null;
};

/** Codes after which sending more messages cannot succeed until configuration changes. */
export const BLOCKING_CODES: ProviderCode[] = ["not_configured", "invalid_key", "model_unavailable", "request_rejected"];

export const PROVIDER_MESSAGES: Record<AssistantErrorCode, string> = {
  not_configured: "AI assistance isn't configured on this deployment (no Gemini API key on the server).",
  invalid_key: "The server's Gemini API key was rejected by Google (invalid, expired or not permitted).",
  model_unavailable: "The configured Gemini model isn't available to this API project.",
  quota: "The free Gemini quota is used up for now. Try again later.",
  timeout: "The AI provider didn't respond in time. Try again.",
  network: "AutoDyn couldn't reach the AI provider. Try again shortly.",
  server_error: "The AI provider returned a temporary error. Try again shortly.",
  request_rejected: "The AI provider rejected AutoDyn's request format. This needs a server-side fix.",
  invalid_output: "The AI returned a response AutoDyn could not validate, so it was discarded. Please rephrase.",
  rate_limited: "You're sending requests quickly. Please wait a moment and try again.",
  invalid_request: "That request could not be processed.",
  message_too_long: "Messages are limited to 800 characters.",
  duplicate: "This message was already sent.",
};

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

export const isBlocking = (code: string | undefined) => !!code && (BLOCKING_CODES as string[]).includes(code);
