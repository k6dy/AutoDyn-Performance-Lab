import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";
import { buildUserTurn, SYSTEM_INSTRUCTION } from "@/lib/ai/prompt";
import { modelOutputJsonSchema, modelOutputSchema } from "@/lib/ai/schema";
import type { ProviderCode, ProviderHealth } from "@/lib/ai/types";

// Both are stable Flash-Lite models with a free tier per ai.google.dev/gemini-api/docs/models
// and /pricing (checked 2026-10). The fallback is used once, only when the configured model is
// reported unavailable/unsupported for the API project.
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_FALLBACK_MODEL = "gemini-3.1-flash-lite";

export type ModelCallResult = { ok: true; text: string; model?: string } | { ok: false; code: ProviderCode; status?: number; reason?: string };

export type ModelCaller = (contents: unknown[], signal: AbortSignal, opts?: { maxOutputTokens?: number; model?: string }) => Promise<ModelCallResult>;

/** Accepts common paste mistakes: surrounding quotes/whitespace and a "models/" prefix. */
export function normalizeModel(raw: string | undefined | null) {
  const v = (raw ?? "").trim().replace(/^["']|["']$/g, "").trim().replace(/^models\//i, "");
  return /^[a-z0-9][a-z0-9.\-]{2,80}$/i.test(v) ? v : null;
}

export function normalizeKey(raw: string | undefined | null) {
  const v = (raw ?? "").trim().replace(/^["']|["']$/g, "").trim();
  return v || null;
}

export function aiConfig() {
  const num = (v: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  const rawKey = process.env.GEMINI_API_KEY;
  const apiKey = normalizeKey(rawKey);
  const rawModel = process.env.GEMINI_MODEL;
  const model = normalizeModel(rawModel) ?? DEFAULT_GEMINI_MODEL;
  const fallbackRaw = process.env.GEMINI_FALLBACK_MODEL;
  const fallbackModel = fallbackRaw === "none" ? null : (normalizeModel(fallbackRaw) ?? DEFAULT_FALLBACK_MODEL);
  return {
    apiKey,
    model,
    fallbackModel: fallbackModel && fallbackModel !== model ? fallbackModel : null,
    maxOutputTokens: num(process.env.AI_MAX_OUTPUT_TOKENS, 1024, 256, 2048),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 15000, 3000, 25000),
    /** Non-secret configuration findings, safe to show. */
    configNotes: [
      rawKey && rawKey !== rawKey.trim() ? "GEMINI_API_KEY has leading/trailing whitespace (ignored)." : null,
      rawKey && /^\s*["']/.test(rawKey) ? "GEMINI_API_KEY is wrapped in quotes (quotes ignored)." : null,
      apiKey && !/^AIza[0-9A-Za-z_\-]{30,}$/.test(apiKey) ? "GEMINI_API_KEY does not look like a Google AI Studio API key (expected to start with “AIza”)." : null,
      rawModel && !normalizeModel(rawModel) ? `GEMINI_MODEL value is not a valid model id; using ${DEFAULT_GEMINI_MODEL}.` : null,
      rawModel && normalizeModel(rawModel) && normalizeModel(rawModel) !== rawModel ? `GEMINI_MODEL normalized to “${normalizeModel(rawModel)}”.` : null,
      !rawModel ? `GEMINI_MODEL not set; using default ${DEFAULT_GEMINI_MODEL}.` : null,
    ].filter((x): x is string => !!x),
  };
}

/** Deployment identity (Vercel system env vars) so a Preview can be matched to project and branch. */
export function deploymentInfo() {
  return {
    environment: process.env.VERCEL_ENV ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    project: process.env.VERCEL_PROJECT_PRODUCTION_URL ?? null,
  };
}

function redact(text: string, key: string | null) {
  let out = text.replace(/AIza[0-9A-Za-z_\-]{20,}/g, "[redacted-key]");
  if (key) out = out.split(key).join("[redacted-key]");
  return out.replace(/\s+/g, " ").slice(0, 240);
}

/** Maps provider failures to stable codes. Only sanitized metadata is ever logged or returned. */
export function classifyProviderError(err: unknown, aborted: boolean, key: string | null): { code: ProviderCode; status?: number; reason: string } {
  if (aborted || (err instanceof Error && (err.name === "AbortError" || /aborted|timed? ?out/i.test(err.message)))) {
    return { code: "timeout", reason: "request aborted after timeout" };
  }
  if (err instanceof ApiError) {
    const msg = redact(err.message ?? "", key);
    const reasonMatch =
      msg.match(/"reason":\s*"([A-Z_]+)"/) ?? msg.match(/\b(API_KEY_[A-Z_]+|RESOURCE_EXHAUSTED|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND|UNAVAILABLE|INTERNAL|FAILED_PRECONDITION)\b/);
    const reason = reasonMatch?.[1] ?? msg.slice(0, 120);
    const s = err.status;
    if (/API_KEY_(SERVICE|HTTP_REFERRER|IP_ADDRESS|ANDROID_APP|IOS_APP)_BLOCKED|referer|referrer|blocked/i.test(msg) && (s === 403 || s === 400)) return { code: "key_restricted", status: s, reason };
    if (s === 401 || /API_KEY_INVALID|API key not valid|API_KEY_EXPIRED|expired/i.test(msg)) return { code: "invalid_key", status: s, reason };
    if (s === 403) return { code: "key_restricted", status: s, reason: reason || "PERMISSION_DENIED" };
    if (s === 404 || /models\/[\w.\-]+ is not found|model.*not found|is not found for API version/i.test(msg)) return { code: "model_unavailable", status: s, reason };
    if (s === 400 && /not supported for (generateContent|structured)|does not support|unsupported model|response_?(json_)?schema.*not supported/i.test(msg)) return { code: "model_unsupported", status: s, reason };
    if (s === 429) return /per ?minute|PerMinute|RATE_LIMIT/i.test(msg) && !/per ?day|PerDay/i.test(msg) ? { code: "provider_rate_limited", status: s, reason } : { code: "quota", status: s, reason };
    if (s === 400 && /location is not supported|FAILED_PRECONDITION/i.test(msg)) return { code: "key_restricted", status: s, reason };
    if (s >= 500) return { code: "server_error", status: s, reason };
    if (s === 400) return { code: "request_rejected", status: s, reason };
    return { code: "server_error", status: s, reason };
  }
  if (err instanceof Error && /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|socket/i.test(`${err.message} ${(err as { cause?: { code?: string } }).cause?.code ?? ""}`)) {
    return { code: "network", reason: "could not reach provider" };
  }
  return { code: "internal_error", reason: err instanceof Error ? redact(err.name, key) : "unknown" };
}

let client: { key: string; ai: GoogleGenAI } | null = null;

function getClient(key: string) {
  if (!client || client.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
}

// ---- Provider health (shared by the readiness probe and real requests) -------------------------

let health: ProviderHealth | null = null;
let probeInFlight: Promise<ProviderHealth> | null = null;

function record(result: ModelCallResult, latencyMs: number | null, source: ProviderHealth["source"], configured: string): ProviderHealth {
  health = {
    status: result.ok ? "ok" : result.code,
    model: configured,
    servedBy: result.ok ? result.model : undefined,
    httpStatus: result.ok ? undefined : result.status,
    reason: result.ok ? undefined : result.reason,
    checkedAt: new Date().toISOString(),
    latencyMs,
    source,
  };
  return health;
}

export function lastProviderHealth() {
  return health;
}

async function callOnce(key: string, model: string, contents: unknown[], signal: AbortSignal, maxOutputTokens: number, timeoutMs: number): Promise<ModelCallResult> {
  try {
    const res = await getClient(key).models.generateContent({
      model,
      contents: contents as never,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: modelOutputJsonSchema,
        maxOutputTokens,
        abortSignal: signal,
        httpOptions: { timeout: timeoutMs },
      },
    });
    const text = res.text;
    if (!text) return { ok: false, code: "invalid_output", reason: String(res.candidates?.[0]?.finishReason ?? "empty response") };
    return { ok: true, text, model };
  } catch (err) {
    const c = classifyProviderError(err, signal.aborted, key);
    return { ok: false, code: c.code, status: c.status, reason: c.reason };
  }
}

/** Real Gemini caller using structured JSON output with a bounded token budget. */
export const geminiCaller: ModelCaller = async (contents, signal, opts) => {
  const cfg = aiConfig();
  if (!cfg.apiKey) return { ok: false, code: "not_configured" };
  const started = Date.now();
  const model = opts?.model ?? cfg.model;
  let result = await callOnce(cfg.apiKey, model, contents, signal, opts?.maxOutputTokens ?? cfg.maxOutputTokens, cfg.timeoutMs);
  if (!result.ok && (result.code === "model_unavailable" || result.code === "model_unsupported") && cfg.fallbackModel && !opts?.model && !signal.aborted) {
    console.error(`[assistant] provider_error ${JSON.stringify({ code: result.code, status: result.status, reason: result.reason, model, fallback: cfg.fallbackModel })}`);
    result = await callOnce(cfg.apiKey, cfg.fallbackModel, contents, signal, opts?.maxOutputTokens ?? cfg.maxOutputTokens, cfg.timeoutMs);
  }
  if (!result.ok) console.error(`[assistant] provider_error ${JSON.stringify({ code: result.code, status: result.status, reason: result.reason, model })}`);
  record(result, Date.now() - started, "request", cfg.model);
  return result;
};

const PROBE_OK_TTL = 10 * 60_000;
const PROBE_FAIL_TTL = 2 * 60_000;

/**
 * Readiness probe: one real, bounded generateContent call in the production request format
 * (system instruction + JSON schema). Confirms authorization, model availability and that the
 * response validates. Cached per server instance unless `force` (token-protected route only).
 */
export async function probeProvider(caller: ModelCaller = geminiCaller, opts: { force?: boolean } = {}, now = Date.now()): Promise<ProviderHealth> {
  const cfg = aiConfig();
  if (!cfg.apiKey) return { status: "not_configured", model: cfg.model, checkedAt: new Date(now).toISOString(), latencyMs: null, source: "probe" };
  if (!opts.force && health && health.model === cfg.model) {
    const age = now - Date.parse(health.checkedAt);
    if (age < (health.status === "ok" ? PROBE_OK_TTL : PROBE_FAIL_TTL)) return health;
  }
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(cfg.timeoutMs, 15000));
    try {
      const contents = [
        {
          role: "user",
          parts: [
            {
              text: buildUserTurn(
                { vehicle: null, stockSpecs: [], modifiedChanges: null, conditions: { temperature: "25 °C", elevation: "0 m", surface: "Dry asphalt" }, units: "imperial", results: null },
                'Connection check. Reply with intent "other", reply "ready", no changes.',
              ),
            },
          ],
        },
      ];
      let r = await caller(contents, controller.signal, { maxOutputTokens: cfg.maxOutputTokens });
      if (r.ok) {
        let valid = false;
        try {
          valid = modelOutputSchema.safeParse(JSON.parse(r.text)).success;
        } catch {
          valid = false;
        }
        if (!valid) r = { ok: false, code: "invalid_output", reason: "response did not match the AutoDyn schema" };
      }
      const h = record(r, Date.now() - started, "probe", cfg.model);
      return h;
    } finally {
      clearTimeout(timer);
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

/** Token-protected deep diagnostic: is the configured model visible to this API project? */
export async function modelVisibility(): Promise<{ configured: string; available: boolean | null; flashLiteModels: string[]; error?: string }> {
  const cfg = aiConfig();
  if (!cfg.apiKey) return { configured: cfg.model, available: null, flashLiteModels: [], error: "not_configured" };
  try {
    const pager = await getClient(cfg.apiKey).models.list({ config: { pageSize: 100 } });
    const names: string[] = [];
    for await (const m of pager) {
      if (m.name) names.push(m.name.replace(/^models\//, ""));
      if (names.length > 300) break;
    }
    return {
      configured: cfg.model,
      available: names.includes(cfg.model),
      flashLiteModels: names.filter((n) => /flash-lite/.test(n)).slice(0, 20),
    };
  } catch (err) {
    const c = classifyProviderError(err, false, cfg.apiKey);
    return { configured: cfg.model, available: null, flashLiteModels: [], error: `${c.code}${c.status ? ` (${c.status})` : ""}: ${c.reason}` };
  }
}

/** Test hook. */
export function resetProviderHealth() {
  health = null;
  probeInFlight = null;
}
