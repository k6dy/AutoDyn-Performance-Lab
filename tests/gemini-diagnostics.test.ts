// Readiness/diagnostic route security and the no-generation access check. Providers are mocked:
// these tests prove gating and classification, not that Google answers (see README for the
// live check).
import { ApiError } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ probe: 0, access: 0, models: 0, force: [] as boolean[] }));

vi.mock("@/lib/ai/gemini.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/gemini.server")>();
  const now = () => new Date().toISOString();
  return {
    ...actual,
    probeProvider: vi.fn(async (_c: unknown, opts?: { force?: boolean }) => {
      calls.probe += 1;
      calls.force.push(!!opts?.force);
      return { status: "ok", model: "gemini-3.5-flash-lite", checkedAt: now(), latencyMs: 5, source: "probe" };
    }),
    verifyAccess: vi.fn(async () => {
      calls.access += 1;
      return { status: "ok", model: "gemini-3.5-flash-lite", checkedAt: now(), latencyMs: 5, source: "access" };
    }),
    modelVisibility: vi.fn(async () => {
      calls.models += 1;
      return { configured: "gemini-3.5-flash-lite", available: true, flashLiteModels: ["gemini-3.5-flash-lite"] };
    }),
  };
});

import { GET as health } from "@/app/api/assistant/health/route";

const KEY = "AIzaSyTESTKEY_abcdefghijklmnopqrstuv";
const TOKEN = "correct-horse-battery-staple-123";
let ip = 0;
const req = (query: string, headers: Record<string, string> = {}) =>
  new Request(`http://t/api/assistant/health${query}`, { headers: { "x-real-ip": `10.0.0.${++ip}`, ...headers } });

beforeEach(() => {
  calls.probe = 0;
  calls.access = 0;
  calls.models = 0;
  calls.force = [];
  vi.stubEnv("GEMINI_API_KEY", KEY);
  vi.stubEnv("AI_DIAGNOSTICS_TOKEN", TOKEN);
});
afterEach(() => vi.unstubAllEnvs());

describe("health route", () => {
  it("plain status reports readiness and variable presence, never the key, and calls no provider", async () => {
    const body = await (await health(req(""))).json();
    expect(body).toMatchObject({ configured: true, env: { GEMINI_API_KEY: true }, probe: null });
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(calls).toMatchObject({ probe: 0, access: 0, models: 0 });
  });

  it("the app's own check verifies key and model without a generation request", async () => {
    const body = await (await health(req("?probe=1", { "sec-fetch-site": "same-origin" }))).json();
    expect(body.probe).toBe("access");
    expect(body.provider.source).toBe("access");
    expect(calls.access).toBe(1);
    expect(calls.probe).toBe(0); // no quota-consuming generation
  });

  it("scripted callers without the token get no live check at all", async () => {
    const body = await (await health(req("?probe=1"))).json();
    expect(body.note).toMatch(/limited to the app itself/);
    expect(calls).toMatchObject({ probe: 0, access: 0 });
    const cross = await (await health(req("?probe=1", { "sec-fetch-site": "cross-site" }))).json();
    expect(cross.probe).toBeNull();
  });

  it("the generation probe and model listing require the diagnostics token", async () => {
    const wrong = await (await health(req("?probe=1&models=1", { authorization: "Bearer nope", "sec-fetch-site": "same-origin" }))).json();
    expect(wrong.probe).toBe("access");
    expect(wrong.models).toBeUndefined();
    expect(calls.probe).toBe(0);
    const ok = await (await health(req("?probe=1&models=1", { authorization: `Bearer ${TOKEN}` }))).json();
    expect(ok.probe).toBe("generation");
    expect(calls.force).toEqual([true]);
    expect(ok.models.available).toBe(true);
    expect(JSON.stringify(ok)).not.toContain(TOKEN);
  });

  it("without a configured (or with a short) token, no request is ever privileged", async () => {
    vi.stubEnv("AI_DIAGNOSTICS_TOKEN", "short");
    const body = await (await health(req("?probe=1&models=1", { authorization: "Bearer short" }))).json();
    expect(body.probe).toBeNull();
    expect(body.models).toBeUndefined();
    expect(calls.probe).toBe(0);
  });

  it("live checks are rate limited", async () => {
    const h = { "sec-fetch-site": "same-origin", "x-real-ip": "203.0.113.9" };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await (await health(new Request("http://t/api/assistant/health?probe=1", { headers: h }))).json());
    expect(calls.access).toBe(3);
    expect(results[3].note).toMatch(/rate limit/);
    const g = [];
    for (let i = 0; i < 3; i++) g.push(await (await health(req("?probe=1", { authorization: `Bearer ${TOKEN}` }))).json());
    // At most 2 generation probes per minute per server instance (one was used by an earlier test).
    expect(calls.probe).toBeLessThanOrEqual(2);
    expect(g[2].note).toMatch(/Diagnostic probe rate limit/);
  });

  it("does nothing live when the key is missing, and says which variable is absent", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_MODEL", "");
    const body = await (await health(req("?probe=1", { "sec-fetch-site": "same-origin" }))).json();
    expect(body).toMatchObject({ configured: false, env: { GEMINI_API_KEY: false, GEMINI_MODEL: false } });
    expect(calls).toMatchObject({ probe: 0, access: 0 });
  });
});

describe("access check and configuration findings (real implementation)", () => {
  it("verifies via model metadata, caches, and classifies failures", async () => {
    const actual = await vi.importActual<typeof import("@/lib/ai/gemini.server")>("@/lib/ai/gemini.server");
    actual.resetProviderHealth();
    const getter = vi.fn(async () => ({ name: "models/gemini-3.5-flash-lite" }));
    const ok = await actual.verifyAccess(getter);
    expect(ok).toMatchObject({ status: "ok", source: "access", model: "gemini-3.5-flash-lite" });
    await actual.verifyAccess(getter);
    expect(getter).toHaveBeenCalledTimes(1); // cached

    actual.resetProviderHealth();
    const invalid = await actual.verifyAccess(async () => {
      throw new ApiError({ status: 400, message: JSON.stringify({ error: { message: "API key not valid.", details: [{ reason: "API_KEY_INVALID" }] } }) });
    });
    expect(invalid.status).toBe("invalid_key");
    actual.resetProviderHealth();
    const missingModel = await actual.verifyAccess(async () => {
      throw new ApiError({ status: 404, message: "models/gemini-9 is not found for API version v1beta" });
    });
    expect(missingModel).toMatchObject({ status: "model_unavailable", httpStatus: 404 });
    actual.resetProviderHealth();
    const quota = await actual.verifyAccess(async () => {
      throw new ApiError({ status: 429, message: "RESOURCE_EXHAUSTED" });
    });
    expect(quota.status).toBe("quota");
    actual.resetProviderHealth();
    vi.stubEnv("GEMINI_API_KEY", "");
    const none = vi.fn();
    expect((await actual.verifyAccess(none)).status).toBe("not_configured");
    expect(none).not.toHaveBeenCalled();
  });

  it("flags misnamed or browser-exposed key variables by name only", async () => {
    const actual = await vi.importActual<typeof import("@/lib/ai/gemini.server")>("@/lib/ai/gemini.server");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", KEY);
    vi.stubEnv("NEXT_PUBLIC_GEMINI_API_KEY", KEY);
    const cfg = actual.aiConfig();
    const notes = cfg.configNotes.join(" ");
    expect(cfg.apiKey).toBeNull(); // only GEMINI_API_KEY is used
    expect(notes).toMatch(/GOOGLE_API_KEY is set, but AutoDyn reads GEMINI_API_KEY/);
    expect(notes).toMatch(/NEXT_PUBLIC_GEMINI_API_KEY is set: NEXT_PUBLIC_ variables are bundled into the browser/);
    expect(notes).not.toContain(KEY);
    expect(cfg.env).toEqual({ GEMINI_API_KEY: false, GEMINI_MODEL: false });
  });
});
