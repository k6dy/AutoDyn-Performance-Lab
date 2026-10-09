import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";
import { buildUserTurn, SYSTEM_INSTRUCTION } from "@/lib/ai/prompt";
import { modelOutputJsonSchema, modelOutputSchema } from "@/lib/ai/schema";
import type { ProviderCode, ProviderHealth } from "@/lib/ai/types";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export type ModelCallResult = { ok: true; text: string } | { ok: false; code: ProviderCode };

export type ModelCaller = (contents: unknown[], signal: AbortSignal, opts?: { maxOutputTokens?: number }) => Promise<ModelCallResult>;

export function aiConfig() {
  const num = (v: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    apiKey: process.env.GEMINI_API_KEY?.trim() || null,
    model: (process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL).replace(/[^a-z0-9.\-]/gi, ""),
    maxOutputTokens: num(process.env.AI_MAX_OUTPUT_TOKENS, 1024, 256, 2048),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 15000, 3000, 25000),
  };
}

/** Deployment identity (Vercel system env vars) so a Preview can be matched to its branch. */
export function deploymentInfo() {
  return {
    environment: process.env.VERCEL_ENV ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  };
}

function redact(text: string, key: string | null) {
  let out = text.replace(/AIza[0-9A-Za-z_\-]{20,}/g, "[redacted-key]");
  if (key) out = out.split(key).join("[redacted-key]");
  return out.replace(/\s+/g, " ").slice(0, 240);
}

/** Maps provider failures to stable codes. Only sanitized metadata is ever logged. */
export function classifyProviderError(err: unknown, aborted: boolean, key: string | null): { code: ProviderCode; status?: number; reason: string } {
  if (aborted || (err instanceof Error && (err.name === "AbortError" || /aborted|timed? ?out/i.test(err.message)))) {
    return { code: "timeout", reason: "request aborted after timeout" };
  }
  if (err instanceof ApiError) {
    const msg = redact(err.message ?? "", key);
    const reasonMatch = msg.match(/"reason":\s*"([A-Z_]+)"/) ?? msg.match(/\b(API_KEY_[A-Z_]+|RESOURCE_EXHAUSTED|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND|UNAVAILABLE|INTERNAL)\b/);
    const reason = reasonMatch?.[1] ?? msg.slice(0, 120);
    const s = err.status;
    if (s === 401 || /API_KEY_INVALID|API key not valid|API_KEY_EXPIRED|expired/i.test(msg)) return { code: "invalid_key", status: s, reason };
    if (s === 403) return { code: "invalid_key", status: s, reason: reason || "PERMISSION_DENIED" };
    if (s === 404 || /model.*(not found|not supported)|is not found for API version/i.test(msg)) return { code: "model_unavailable", status: s, reason };
    if (s === 429) return { code: "quota", status: s, reason };
    if (s >= 500) return { code: "server_error", status: s, reason };
    if (s === 400) return { code: "request_rejected", status: s, reason };
    return { code: "server_error", status: s, reason };
  }
  if (err instanceof Error && /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|socket/i.test(`${err.message} ${(err as { cause?: { code?: string } }).cause?.code ?? ""}`)) {
    return { code: "network", reason: "could not reach provider" };
  }
  return { code: "server_error", reason: err instanceof Error ? redact(err.name, key) : "unknown" };
}

let client: { key: string; ai: GoogleGenAI } | null = null;

function getClient(key: string) {
  if (!client || client.key !== key) client = { key, ai: new GoogleGenAI({ apiKey: key }) };
  return client.ai;
}

// ---- Provider health (shared by the readiness probe and real requests) -------------------------

let health: ProviderHealth | null = null;
let probeInFlight: Promise<ProviderHealth> | null = null;

export function recordProviderResult(status: ProviderHealth["status"], latencyMs: number | null, source: ProviderHealth["source"]) {
  health = { status, model: aiConfig().model, checkedAt: new Date().toISOString(), latencyMs, source };
}

export function lastProviderHealth() {
  return health;
}

/** Real Gemini caller using structured JSON output with a bounded token budget. */
export const geminiCaller: ModelCaller = async (contents, signal, opts) => {
  const cfg = aiConfig();
  if (!cfg.apiKey) return { ok: false, code: "not_configured" };
  const started = Date.now();
  try {
    const res = await getClient(cfg.apiKey).models.generateContent({
      model: cfg.model,
      contents: contents as never,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: modelOutputJsonSchema,
        maxOutputTokens: opts?.maxOutputTokens ?? cfg.maxOutputTokens,
        abortSignal: signal,
        httpOptions: { timeout: cfg.timeoutMs },
      },
    });
    const text = res.text;
    if (!text) {
      console.error(`[assistant] provider_result ${JSON.stringify({ code: "invalid_output", reason: res.candidates?.[0]?.finishReason ?? "empty", model: cfg.model })}`);
      recordProviderResult("invalid_output", Date.now() - started, "request");
      return { ok: false, code: "invalid_output" };
    }
    recordProviderResult("ok", Date.now() - started, "request");
    return { ok: true, text };
  } catch (err) {
    const c = classifyProviderError(err, signal.aborted, cfg.apiKey);
    console.error(`[assistant] provider_error ${JSON.stringify({ ...c, model: cfg.model })}`);
    recordProviderResult(c.code, Date.now() - started, "request");
    return { ok: false, code: c.code };
  }
};

const PROBE_OK_TTL = 10 * 60_000;
const PROBE_FAIL_TTL = 60_000;

/**
 * Readiness probe: a real, bounded generateContent call using the production request format
 * (system instruction + JSON schema). Confirms key authorization, model availability and that the
 * response validates. Cached per server instance so it cannot drain the free quota.
 */
export async function probeProvider(caller: ModelCaller = geminiCaller, now = Date.now()): Promise<ProviderHealth> {
  const cfg = aiConfig();
  if (!cfg.apiKey) return { status: "not_configured", model: cfg.model, checkedAt: new Date(now).toISOString(), latencyMs: null, source: "probe" };
  if (health?.source === "probe" || health?.source === "request") {
    const age = now - Date.parse(health.checkedAt);
    if (age < (health.status === "ok" ? PROBE_OK_TTL : PROBE_FAIL_TTL) && health.model === cfg.model) return health;
  }
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(cfg.timeoutMs, 12000));
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
      const r = await caller(contents, controller.signal, { maxOutputTokens: 400 });
      let status: ProviderHealth["status"] = r.ok ? "ok" : r.code;
      if (r.ok) {
        try {
          if (!modelOutputSchema.safeParse(JSON.parse(r.text)).success) status = "invalid_output";
        } catch {
          status = "invalid_output";
        }
      }
      health = { status, model: cfg.model, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, source: "probe" };
      return health;
    } finally {
      clearTimeout(timer);
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

/** Test hook. */
export function resetProviderHealth() {
  health = null;
  probeInFlight = null;
}
