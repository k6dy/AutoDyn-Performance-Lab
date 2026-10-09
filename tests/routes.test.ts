import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as assistantStatus, POST as assistantPost } from "@/app/api/assistant/route";
import { POST as simulate } from "@/app/api/simulate/route";
import { GET as makes } from "@/app/api/vehicles/makes/route";
import { GET as models } from "@/app/api/vehicles/models/route";
import { GET as spec } from "@/app/api/vehicles/spec/route";
import { GET as trims } from "@/app/api/vehicles/trims/route";
import { GET as vin } from "@/app/api/vehicles/vin/route";
import { config } from "./support/fixtures";

const get = (path: string) => new Request(`http://test${path}`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("vehicle API routes", () => {
  it("serves dependent dataset options", async () => {
    const m = await (await makes(get("/api/vehicles/makes?year=2015"))).json();
    expect(m.source).toBe("dataset");
    expect(m.makes).toContain("Mercedes-Benz");
    const md = await (await models(get("/api/vehicles/models?year=2015&make=Mercedes-Benz"))).json();
    expect(md.models).toContain("C300");
    const t = await (await trims(get("/api/vehicles/trims?year=2015&make=Mercedes-Benz&model=C300"))).json();
    expect(t.trims.length).toBeGreaterThan(0);
    const s = await (await spec(get(`/api/vehicles/spec?trimId=${t.trims[0].id}`))).json();
    expect(s.specSet.identity.model).toBe("C300");
  });

  it("validates parameters", async () => {
    expect((await makes(get("/api/vehicles/makes?year=1700"))).status).toBe(400);
    expect((await models(get("/api/vehicles/models?year=2015&make=<script>"))).status).toBe(400);
    expect((await spec(get("/api/vehicles/spec?trimId=abc"))).status).toBe(400);
    expect((await spec(get("/api/vehicles/spec?trimId=999999999"))).status).toBe(404);
    expect((await vin(get("/api/vehicles/vin?vin=SHORT"))).status).toBe(400);
  });

  it("returns an empty model list (not an error) for an invalid dataset combination", async () => {
    const r = await (await models(get("/api/vehicles/models?year=2015&make=Yugo"))).json();
    expect(r.models).toEqual([]);
  });

  it("reports a recoverable error when NHTSA fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    const res = await models(get("/api/vehicles/models?year=2008&make=Honda"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.retryable).toBe(true);
    expect(body.error).toMatch(/custom vehicle/);
  });

  it("uses NHTSA for years outside the dataset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Results: [{ Model_Name: "Civic" }, { Model_Name: "Accord" }] }))));
    const body = await (await models(get("/api/vehicles/models?year=2008&make=Honda"))).json();
    expect(body).toMatchObject({ source: "nhtsa", models: ["Accord", "Civic"] });
  });
});

describe("assistant API route", () => {
  it("reports AI unavailable without a key and never calls a provider", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await (await assistantStatus()).json()).toEqual({ available: false, model: null });
    const res = await assistantPost(
      new Request("http://test/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: "abcdefgh1234", message: "hi", history: [], context: { vehicle: null, stockSpecs: [], modifiedChanges: null, conditions: { temperature: "", elevation: "", surface: "" }, units: "imperial", results: null } }),
      }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe("AI assistance is temporarily unavailable. Manual Setup is still ready to use.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-JSON and oversized bodies", async () => {
    expect((await assistantPost(new Request("http://test/api/assistant", { method: "POST", body: "x" }))).status).toBe(415);
    const big = new Request("http://test/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "x".repeat(70000) }) });
    expect((await assistantPost(big)).status).toBe(413);
  });

  it("does not expose the key in status responses", async () => {
    vi.stubEnv("GEMINI_API_KEY", "secret-test-key-123");
    const text = await (await assistantStatus()).text();
    expect(text).not.toMatch(/secret-test-key/);
    expect(JSON.parse(text).available).toBe(true);
  });
});

describe("simulate API route", () => {
  it("runs the shared engine for a valid configuration", async () => {
    const res = await simulate(new Request("http://test/api/simulate", { method: "POST", body: JSON.stringify(config()) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stock.metrics.zeroTo60S).toBeGreaterThan(5);
    expect(body.findings.length).toBeGreaterThan(0);
  });

  it("fails safely for invalid inputs", async () => {
    const bad = config();
    bad.stock!.values.curbMassKg = { value: -1, provenance: "user" };
    expect((await simulate(new Request("http://test/api/simulate", { method: "POST", body: JSON.stringify(bad) }))).status).toBe(422);
    expect((await simulate(new Request("http://test/api/simulate", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await simulate(new Request("http://test/api/simulate", { method: "POST", body: JSON.stringify({ stock: 1 }) }))).status).toBe(400);
  });
});
