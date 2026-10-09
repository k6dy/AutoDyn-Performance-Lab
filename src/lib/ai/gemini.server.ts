import "server-only";
import { ApiError, GoogleGenAI } from "@google/genai";
import { modelOutputJsonSchema } from "@/lib/ai/schema";
import { SYSTEM_INSTRUCTION } from "@/lib/ai/prompt";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export type ModelCallResult =
  | { ok: true; text: string }
  | { ok: false; code: "ai_unavailable" | "quota" | "timeout" | "provider_error" | "invalid_output" };

export type ModelCaller = (contents: unknown[], signal: AbortSignal) => Promise<ModelCallResult>;

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

let client: { key: string; ai: GoogleGenAI } | null = null;

/** Real Gemini caller. Uses structured JSON output with a bounded token budget. */
export const geminiCaller: ModelCaller = async (contents, signal) => {
  const cfg = aiConfig();
  if (!cfg.apiKey) return { ok: false, code: "ai_unavailable" };
  if (!client || client.key !== cfg.apiKey) client = { key: cfg.apiKey, ai: new GoogleGenAI({ apiKey: cfg.apiKey }) };
  try {
    const res = await client.ai.models.generateContent({
      model: cfg.model,
      contents: contents as never,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: modelOutputJsonSchema,
        maxOutputTokens: cfg.maxOutputTokens,
        temperature: 0.2,
        abortSignal: signal,
        httpOptions: { timeout: cfg.timeoutMs },
      },
    });
    const text = res.text;
    if (!text) return { ok: false, code: "invalid_output" };
    return { ok: true, text };
  } catch (err) {
    if (signal.aborted || (err instanceof Error && /abort|timeout/i.test(err.name + err.message))) return { ok: false, code: "timeout" };
    if (err instanceof ApiError) {
      // Log status only — never the request, key or raw upstream body.
      console.warn(`[assistant] Gemini API error status=${err.status}`);
      if (err.status === 429) return { ok: false, code: "quota" };
      if ([401, 403, 404].includes(err.status)) return { ok: false, code: "ai_unavailable" };
      return { ok: false, code: "provider_error" };
    }
    console.warn("[assistant] Gemini request failed");
    return { ok: false, code: "provider_error" };
  }
};
