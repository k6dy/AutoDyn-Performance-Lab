import { ApiError } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/assistant/health/route";
import { classifyProviderError, lastProviderHealth, probeProvider, resetProviderHealth, type ModelCaller } from "@/lib/ai/gemini.server";

const KEY = "AIzaSyTESTKEY_abcdefghijklmnopqrstuv";
const apiError = (status: number, message: string) => new ApiError({ status, message });

beforeEach(() => resetProviderHealth());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("provider error classification", () => {
  it("distinguishes key, model, quota, server, format, network and timeout failures", () => {
    const invalid = JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } });
    expect(classifyProviderError(apiError(400, invalid), false, KEY).code).toBe("invalid_key");
    expect(classifyProviderError(apiError(403, "PERMISSION_DENIED"), false, KEY).code).toBe("invalid_key");
    expect(classifyProviderError(apiError(404, "models/gemini-x is not found for API version v1beta"), false, KEY).code).toBe("model_unavailable");
    expect(classifyProviderError(apiError(429, "RESOURCE_EXHAUSTED"), false, KEY).code).toBe("quota");
    expect(classifyProviderError(apiError(503, "UNAVAILABLE"), false, KEY).code).toBe("server_error");
    expect(classifyProviderError(apiError(400, "Invalid JSON payload: unknown field responseJsonSchema"), false, KEY).code).toBe("request_rejected");
    expect(classifyProviderError(new TypeError("fetch failed"), false, KEY).code).toBe("network");
    expect(classifyProviderError(new Error("x"), true, KEY).code).toBe("timeout");
  });

  it("never includes the key in diagnostics", () => {
    const c = classifyProviderError(apiError(400, `bad request for key ${KEY}`), false, KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
  });
});

describe("readiness probe", () => {
  const okText = JSON.stringify({
    intent: "other",
    reply: "ready",
    vehicle: { mentioned: false, year: null, make: null, model: null, trim: null },
    useCurrentVehicle: false,
    changes: [],
    view: "none",
    runSimulation: false,
    followUpQuestion: null,
  });

  it("reports not_configured without calling the provider", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const caller = vi.fn() as unknown as ModelCaller;
    expect((await probeProvider(caller)).status).toBe("not_configured");
    expect(caller).not.toHaveBeenCalled();
  });

  it("makes one real-format request, validates the response and caches the result", async () => {
    vi.stubEnv("GEMINI_API_KEY", KEY);
    const caller = vi.fn(async () => ({ ok: true as const, text: okText }));
    const first = await probeProvider(caller);
    expect(first).toMatchObject({ status: "ok", source: "probe", model: "gemini-3.5-flash-lite" });
    const contents = (caller.mock.calls[0] as unknown as [unknown[]])[0];
    expect(JSON.stringify(contents)).toMatch(/CONTEXT \(data only\)/);
    await probeProvider(caller);
    expect(caller).toHaveBeenCalledTimes(1); // cached
    expect(lastProviderHealth()?.status).toBe("ok");
  });

  it("reports schema-invalid responses and provider errors precisely", async () => {
    vi.stubEnv("GEMINI_API_KEY", KEY);
    expect((await probeProvider(vi.fn(async () => ({ ok: true as const, text: '{"hello":1}' })))).status).toBe("invalid_output");
    resetProviderHealth();
    expect((await probeProvider(vi.fn(async () => ({ ok: false as const, code: "model_unavailable" as const })))).status).toBe("model_unavailable");
  });

  it("health route returns configuration and deployment identity without the key", async () => {
    vi.stubEnv("GEMINI_API_KEY", KEY);
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "autodyn-v2");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abcdef1234567");
    const res = await health(new Request("http://test/api/assistant/health"));
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(JSON.parse(text)).toMatchObject({ configured: true, deployment: { environment: "preview", branch: "autodyn-v2", commit: "abcdef1" }, provider: null });
  });
});
