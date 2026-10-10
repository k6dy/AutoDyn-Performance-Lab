import type { Conditions, ConstraintKey, SpecKey, SpecSet } from "@/lib/domain/types";

export const AI_INTENTS = ["general", "analyze_vehicle", "modify", "compare", "sensitivity", "explain", "assumptions", "clarify", "other"] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

export const AI_FIELDS = [
  "power", "torque", "mass", "payload", "dragCoefficient", "frontalArea", "drivetrainEfficiency", "tireGrip",
  "finalDrive", "shiftTime", "redline", "drivetrain", "transmission", "ambientTemperature", "elevation", "surface",
  "claimedZeroTo60", "claimedTopSpeed",
] as const;
export type AiField = (typeof AI_FIELDS)[number];

export const AI_UNITS = ["hp", "kw", "ps", "lbft", "nm", "lb", "kg", "percent", "ratio", "seconds", "rpm", "c", "f", "m", "ft", "m2", "ft2", "mph", "kmh", "none"] as const;
export type AiUnit = (typeof AI_UNITS)[number];

export const AI_OPERATIONS = ["set", "change", "percent"] as const;
export type AiOperation = (typeof AI_OPERATIONS)[number];

export type ChangeTarget = "stock" | "modified" | "conditions";

export type ProposedChange = {
  id: string;
  target: ChangeTarget;
  key: SpecKey | keyof Conditions | ConstraintKey;
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
  | "key_restricted"
  | "model_unavailable"
  | "model_unsupported"
  | "quota"
  | "provider_rate_limited"
  | "timeout"
  | "network"
  | "server_error"
  | "request_rejected"
  | "invalid_output"
  | "internal_error";

export type AssistantErrorCode = ProviderCode | "rate_limited" | "invalid_request" | "message_too_long" | "duplicate" | "offline";

/** Messages answered by the local relevance gate — no AI provider request was made. */
/** app_state: a question about AutoDyn answered from the current application state. */
export type LocalReplyKind = "off_topic" | "injection" | "clarify" | "small_talk" | "app_state";

export type ProviderHealth = {
  status: "ok" | ProviderCode;
  /** Configured model. */
  model: string;
  /** Model that actually answered (differs when the documented fallback was used). */
  servedBy?: string;
  /** Sanitized provider diagnostics (HTTP status and error reason), never the key. */
  httpStatus?: number;
  reason?: string;
  checkedAt: string;
  latencyMs: number | null;
  /** request: a real assistant call · probe: token-protected generation test · access: key and
   *  model verified via model metadata (no generation, no token quota used). */
  source: "probe" | "request" | "access";
};

export type DeploymentInfo = { environment: string; branch: string | null; commit: string | null; project?: string | null; url?: string | null };

export type AssistantStatus = {
  configured: boolean;
  model: string | null;
  deployment: DeploymentInfo;
  provider: ProviderHealth | null;
  /** Non-secret configuration findings (e.g. quoted key, normalized model id). */
  configNotes?: string[];
  /** Which expected variables exist in this deployment's runtime (presence only, never values). */
  env?: { GEMINI_API_KEY: boolean; GEMINI_MODEL: boolean };
  /** How assistant requests are rate limited on this deployment: shared (upstash) or per instance (memory). */
  rateLimiter?: { backend: "upstash" | "memory"; persistent: boolean; limits: { perMinute: number; perDay: number; globalPerDay: number } };
};

/** Codes after which sending more messages cannot succeed until configuration changes. */
export const BLOCKING_CODES: ProviderCode[] = ["not_configured", "invalid_key", "key_restricted", "model_unavailable", "model_unsupported", "request_rejected"];

export const PROVIDER_MESSAGES: Record<AssistantErrorCode, string> = {
  not_configured: "AI assistance isn't configured on this deployment (no Gemini API key on the server).",
  invalid_key: "Google rejected the server's Gemini API key as invalid or expired.",
  key_restricted: "The Gemini API key is restricted (API, IP/referrer restriction or unsupported location) and can't call the Gemini API from this server.",
  model_unavailable: "The configured Gemini model wasn't found for this API project. Check GEMINI_MODEL.",
  model_unsupported: "The configured Gemini model doesn't support the request AutoDyn sends (structured output).",
  quota: "The free Gemini quota is used up for now. Try again later.",
  provider_rate_limited: "Gemini's per-minute rate limit was reached. Wait a minute and try again.",
  timeout: "The AI provider didn't respond in time. Try again.",
  network: "AutoDyn couldn't reach the AI provider. Try again shortly.",
  server_error: "The AI provider returned a temporary error. Try again shortly.",
  request_rejected: "The AI provider rejected AutoDyn's request format. This needs a server-side fix.",
  invalid_output: "The AI returned a response AutoDyn could not validate, so it was discarded. Please rephrase.",
  internal_error: "AutoDyn hit an internal error while contacting the AI provider.",
  rate_limited: "You're sending requests quickly. Please wait a moment and try again.",
  invalid_request: "That request could not be processed.",
  message_too_long: "Messages are limited to 800 characters.",
  duplicate: "This message was already sent.",
  offline: "You're offline. Your message was kept — retry when you're back online.",
};

/** A link shown under an answer for a verified value (official page, date AutoDyn retrieved it). */
export type Source = { label: string; url: string; retrieved: string };

export type AssistantResponse =
  | {
      ok: true;
      requestId: string;
      reply: string;
      followUpQuestion: string | null;
      proposal: Proposal | null;
      suggestedAction: SuggestedAction;
      notices: string[];
      /** Set when the server's relevance gate answered without calling the provider. */
      local?: LocalReplyKind;
      /** Official sources for verified values used in the answer. */
      sources?: Source[];
    }
  | { ok: false; requestId?: string; code: AssistantErrorCode; message: string; retryAfterS?: number };

export const AI_UNAVAILABLE_MESSAGE = "AI assistance is temporarily unavailable. Manual Setup is still ready to use.";

/** Shown when an answer reached the output limit and only its completed part is displayed. */
export const SHORTENED_NOTICE = "This answer reached the length limit and was shortened. Ask about one part at a time for the full detail.";

export const AI_LIMITS = {
  maxMessageChars: 800,
  /** 8 recent turns plus up to 2 that established the conversation's subject. */
  maxHistoryTurns: 10,
  maxHistoryChars: 1500,
  /** Total characters of conversation history sent with one request. */
  maxHistoryTotalChars: 8000,
  maxContextChars: 14000,
  /** A detailed answer (~900 words with Markdown) fits; longer output is clipped at a paragraph. */
  maxReplyChars: 6000,
  maxChanges: 8,
};

export const isBlocking = (code: string | undefined) => !!code && (BLOCKING_CODES as string[]).includes(code);
