import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/assistant/health/route";
import { applyProposal } from "@/lib/ai/apply";
import { buildAssistantContext } from "@/lib/ai/context";
import { aiConfig, normalizeKey, normalizeModel } from "@/lib/ai/gemini.server";
import { handleAssistantRequest, type AssistantDeps } from "@/lib/ai/handler";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import type { ModelOutput } from "@/lib/ai/schema";
import { DEFAULT_CONDITIONS, type AnalysisConfig } from "@/lib/domain/types";
import { runAnalysis } from "@/lib/physics/analysis";
import { CSS_TOKENS, FEASIBILITY_COLORS, SCENARIO_COLORS, VALIDATION_COLORS } from "@/lib/theme";
import { hpToKw } from "@/lib/units";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";

const c300 = () => datasetSpecSet(allDatasetTrims().find((t) => t.year === 2015 && t.model === "C300" && t.drive === "rear wheel drive" && /^C 300 4dr/.test(t.description ?? ""))!);

afterEach(() => vi.unstubAllEnvs());

describe("semantic color system", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  it("CSS tokens match the central palette exactly", () => {
    for (const [token, hex] of Object.entries(CSS_TOKENS)) {
      const m = css.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
      expect(m?.[1].toLowerCase(), token).toBe(hex.toLowerCase());
    }
  });
  it("uses the specified identity, validation and feasibility colors", () => {
    expect(SCENARIO_COLORS).toEqual({ stock: "#79A7FF", modified: "#E87942" });
    expect(VALIDATION_COLORS).toEqual({ error: "#EF6464", warning: "#E9B35B", success: "#50C49A" });
    expect(FEASIBILITY_COLORS).toEqual({ feasible: "#50C49A", questionable: "#E9B35B", non_feasible: "#E45B70", insufficient_data: "#9299A3" });
  });
  it("palettes stay separate: the non-feasible rose is not the input-error red", () => {
    expect(FEASIBILITY_COLORS.non_feasible).not.toBe(VALIDATION_COLORS.error);
    expect(SCENARIO_COLORS.modified).not.toBe(VALIDATION_COLORS.error);
  });
  it("colors are readable on the dark surface (WCAG contrast ≥ 4.5:1)", () => {
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const surface = lum("#191C1F");
    for (const hex of [...Object.values(SCENARIO_COLORS), ...Object.values(VALIDATION_COLORS), ...Object.values(FEASIBILITY_COLORS)]) {
      expect((lum(hex) + 0.05) / (surface + 0.05), hex).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Gemini configuration diagnostics", () => {
  it("normalizes common paste mistakes in model id and key", () => {
    expect(normalizeModel("models/gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect(normalizeModel(' "gemini-3.5-flash-lite" ')).toBe("gemini-3.5-flash-lite");
    expect(normalizeModel("gemini 3.5 flash lite")).toBeNull();
    expect(normalizeKey(' "AIzaSyABC" ')).toBe("AIzaSyABC");
  });
  it("reports non-secret configuration findings without revealing the key", () => {
    vi.stubEnv("GEMINI_API_KEY", '"not-a-google-key"');
    vi.stubEnv("GEMINI_MODEL", "models/gemini-3.5-flash-lite");
    const c = aiConfig();
    expect(c.model).toBe("gemini-3.5-flash-lite");
    expect(c.fallbackModel).toBe("gemini-3.1-flash-lite");
    expect(c.configNotes.join(" ")).toMatch(/wrapped in quotes/);
    expect(c.configNotes.join(" ")).toMatch(/does not look like a Google AI Studio API key/);
    expect(c.configNotes.join(" ")).toMatch(/normalized/);
    expect(JSON.stringify(c.configNotes)).not.toMatch(/not-a-google-key/);
  });
  it("live probes require a same-origin page request or the diagnostics token", async () => {
    vi.stubEnv("GEMINI_API_KEY", "AIzaSyTESTKEY_abcdefghijklmnopqrstuv");
    vi.stubEnv("AI_DIAGNOSTICS_TOKEN", "correct-horse-battery-staple-123");
    const scripted = await (await health(new Request("http://t/api/assistant/health?probe=1"))).json();
    expect(scripted.note).toMatch(/limited to the app itself/);
    expect(scripted.provider).toBeNull();
    const wrongToken = await (await health(new Request("http://t/api/assistant/health?probe=1&models=1", { headers: { authorization: "Bearer nope" } }))).json();
    expect(wrongToken.models).toBeUndefined();
    expect(wrongToken.provider).toBeNull();
    expect(JSON.stringify(wrongToken)).not.toMatch(/AIzaSyTESTKEY/);
  });
});

describe("AI explains the deterministic results without overriding them", () => {
  const out = (patch: Partial<ModelOutput>): ModelOutput => ({
    intent: "explain",
    reply: "",
    vehicle: { mentioned: false, year: null, make: null, model: null, trim: null },
    useCurrentVehicle: true,
    changes: [],
    view: "none",
    runSimulation: false,
    followUpQuestion: null,
    ...patch,
  });
  const deps = (o: ModelOutput): AssistantDeps => ({
    configured: true,
    timeoutMs: 500,
    callModel: async () => ({ ok: true, text: JSON.stringify(o) }),
    limiter: new MemoryRateLimiter({ perMinute: 100, perDay: 100, globalPerDay: 100 }),
    clientKey: "t",
    trims: allDatasetTrims,
    nhtsaModels: async () => [],
  });
  let n = 0;
  const req = (config: AnalysisConfig, message: string) => {
    const analysis = runAnalysis(config);
    n += 1;
    return { requestId: `feas${String(n).padStart(6, "0")}`, message, history: [], context: buildAssistantContext(config, { analysis, stale: false }, "imperial") };
  };
  const modified: AnalysisConfig = { stock: c300(), modified: { overrides: { peakPowerKw: { value: hpToKw(281), provenance: "user" } } }, conditions: { ...DEFAULT_CONDITIONS } };

  it("context carries the engine's feasibility and computed metrics", () => {
    const ctx = req(modified, "x").context;
    expect(ctx.results!.feasibility!.join(" ")).toMatch(/Stock feasibility: Feasible within modeled constraints/);
    expect(ctx.results!.feasibility!.join(" ")).toMatch(/Modified feasibility: Requires further verification/);
    expect(ctx.results!.metrics.find((m) => m.metric === "0–60 mph")!.modified).toMatch(/\d\.\d\d s/);
  });

  it("flags a reply that contradicts the deterministic classification", async () => {
    const r = await handleAssistantRequest(req(modified, "Is the modified build feasible?"), deps(out({ reply: "Yes — the modified build is fully feasible." })));
    expect(r.body.ok).toBe(true);
    if (r.body.ok) expect(r.body.notices.join(" ")).toMatch(/deterministic feasibility assessment is authoritative/);
  });

  it("does not flag a reply that agrees with it", async () => {
    const r = await handleAssistantRequest(req(modified, "Why?"), deps(out({ reply: "Stock is feasible; the modified version requires further verification because component ratings are unknown." })));
    if (r.body.ok) expect(r.body.notices.join(" ")).not.toMatch(/authoritative/);
  });

  it("a stated performance claim becomes an approvable proposal that the engine then judges", async () => {
    const config: AnalysisConfig = { stock: c300(), modified: null, conditions: { ...DEFAULT_CONDITIONS } };
    const r = await handleAssistantRequest(
      req(config, "My C300 does 0-60 in 2 seconds."),
      deps(out({ intent: "assumptions", reply: "AutoDyn will check that claim.", changes: [{ scenario: "stock", field: "claimedZeroTo60", operation: "set", value: 2, unit: "seconds", option: "", reason: "0-60 in 2 seconds" }], runSimulation: true })),
    );
    expect(r.body.ok).toBe(true);
    if (!r.body.ok) return;
    const change = r.body.proposal!.changes[0];
    expect(change).toMatchObject({ key: "claimedZeroTo60S", target: "stock", statedByUser: true });
    expect(config.constraints).toBeUndefined(); // nothing applied yet
    const applied = applyProposal(config, r.body.proposal!, { selected: { [change.id]: true } }).config;
    expect(applied.constraints!.stock!.claimedZeroTo60S).toBe(2);
    expect(runAnalysis(applied).feasibility.stock.status).toBe("non_feasible");
  });
});
