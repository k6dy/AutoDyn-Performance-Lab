// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as makesRoute } from "@/app/api/vehicles/makes/route";
import { GET as modelsRoute } from "@/app/api/vehicles/models/route";
import { GET as specRoute } from "@/app/api/vehicles/spec/route";
import { GET as trimsRoute } from "@/app/api/vehicles/trims/route";
import AppShell from "@/components/AppShell";
import LoadingStage, { BrandGlyph } from "@/components/LoadingStage";
import { handleAssistantRequest } from "@/lib/ai/handler";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import type { ModelOutput } from "@/lib/ai/schema";
import { runAnalysis } from "@/lib/physics/analysis";
import { datasetTrimToSpecSet } from "@/lib/vehicles/normalize";
import { allDatasetTrims } from "@/lib/vehicles/dataset.server";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { AppProvider } from "@/state/AppProvider";

type Handler = (req: Request) => Promise<Response> | Response;

let aiConfigured = true;
let modelOutput: ModelOutput | null = null;
let failNhtsa = false;
let hangModels = false;
let assistantCalls = 0;
let reducedMotion = false;

const deployment = { environment: "preview", branch: "autodyn-v2", commit: "abc1234" };
const routes: Record<string, Handler> = {
  "/api/vehicles/makes": makesRoute,
  "/api/vehicles/models": async (req) => {
    if (hangModels) return new Promise<Response>((_, reject) => req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    if (failNhtsa && !/year=20(1[5-9]|20)/.test(req.url)) return Response.json({ error: "NHTSA vPIC did not respond.", retryable: true }, { status: 502 });
    return modelsRoute(req);
  },
  "/api/vehicles/trims": trimsRoute,
  "/api/vehicles/spec": specRoute,
  "/api/assistant/health": async () =>
    Response.json({
      configured: aiConfigured,
      model: "gemini-3.5-flash-lite",
      deployment,
      provider: aiConfigured ? { status: "ok", model: "gemini-3.5-flash-lite", checkedAt: new Date().toISOString(), latencyMs: 300, source: "probe" } : null,
    }),
  "/api/assistant": async (req) => {
    if (req.method === "GET") return Response.json({ configured: aiConfigured, model: "gemini-3.5-flash-lite", deployment, provider: null });
    assistantCalls += 1;
    const result = await handleAssistantRequest(await req.json(), {
      configured: aiConfigured,
      timeoutMs: 1000,
      callModel: async () => ({ ok: true, text: JSON.stringify(modelOutput) }),
      limiter: new MemoryRateLimiter({ perMinute: 100, perDay: 100, globalPerDay: 100 }),
      clientKey: "ui-test",
      trims: allDatasetTrims,
      nhtsaModels: async () => [],
    });
    return Response.json(result.body, { status: result.status });
  },
};

const defaultAssistantRoute = routes["/api/assistant"];
beforeEach(() => {
  routes["/api/assistant"] = defaultAssistantRoute;
  aiConfigured = true;
  modelOutput = null;
  failNhtsa = false;
  hangModels = false;
  assistantCalls = 0;
  reducedMotion = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://test");
      const handler = routes[url.pathname];
      if (!handler) throw new Error(`Unexpected fetch ${url}`);
      return handler(new Request(url, init));
    }),
  );
  window.matchMedia = ((q: string) => ({ matches: reducedMotion && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollTo = function () {} as never;
  // jsdom has no layout; give chart containers a size so Recharts can render.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 260 });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 260, top: 0, left: 0, right: 600, bottom: 260, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderApp() {
  return render(
    <AppProvider>
      <AppShell />
    </AppProvider>,
  );
}

async function choose(id: string, predicate: (o: HTMLOptionElement) => boolean) {
  const select = (await waitFor(
    () => {
      const el = document.getElementById(id) as HTMLSelectElement;
      if (el.disabled) throw new Error(`${id} not ready`);
      if (![...el.options].some(predicate)) throw new Error(`${id} options not loaded`);
      return el;
    },
    { timeout: 5000 },
  )) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: [...select.options].find(predicate)!.value } });
}

const runButton = () => screen.getAllByRole("button", { name: /Run analysis/ })[0];

async function loadTrim(year: string, make: string, model: string, trim: (o: HTMLOptionElement) => boolean) {
  await choose("sel-year", (o) => o.value === year);
  await choose("sel-make", (o) => o.value === make);
  await choose("sel-model", (o) => o.value === model);
  await choose("sel-trim", trim);
}

async function loadC300() {
  await loadTrim("2015", "Mercedes-Benz", "C300", (o) => /^C 300 4dr Sedan/.test(o.text) && /rear wheel drive/.test(o.text));
  await screen.findByText("Key specifications", undefined, { timeout: 5000 });
}

function setField(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

async function metricRow(label: RegExp) {
  const table = await screen.findByRole("table", { name: /Computed performance metrics/ }, { timeout: 8000 });
  return within(table).getByRole("rowheader", { name: label }).closest("tr")!;
}

const fieldValue = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
const openAdvanced = () => fireEvent.click(screen.getByRole("button", { name: /Advanced Settings/ }));

async function openAssistant() {
  fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
  const input = (await screen.findByLabelText(/Message the AI Build Assistant/)) as HTMLTextAreaElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  return input;
}

describe("Basic Setup", () => {
  it("runs a standard analysis without touching Advanced Settings; numbers come from the physics engine", async () => {
    renderApp();
    await loadC300();
    expect(fieldValue("f-peakPowerKw")).toBe("241");
    expect(fieldValue("f-curbMassKg")).toBe("3417"); // dataset curb weight for this trim
    expect(screen.getByRole("button", { name: /Advanced Settings/ }).getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("f-dragCoefficient")).toBeNull(); // technical fields hidden by default
    fireEvent.click(runButton());
    const row = await metricRow(/0–60 mph/);
    const trim = allDatasetTrims().find((t) => t.year === 2015 && t.model === "C300" && t.drive === "rear wheel drive" && /^C 300 4dr/.test(t.description ?? ""))!;
    const expected = runAnalysis({ stock: datasetTrimToSpecSet(trim), modified: null, conditions: { ...DEFAULT_CONDITIONS } }).stock.metrics.zeroTo60S!;
    expect(row.textContent).toContain(expected.toFixed(2));
    expect(screen.getByRole("tab", { name: /Results/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("simple modification controls create an independent Modified scenario", async () => {
    renderApp();
    await loadC300();
    fireEvent.click(screen.getByRole("radio", { name: /Stock vs\. modified/ }));
    setField("d-peakPowerKw", "+40");
    setField("d-curbMassKg", "-150");
    expect(document.getElementById("d-peakPowerKw-hint")!.textContent).toMatch(/Modified: 281 hp · Stock: 241 hp/);
    expect(fieldValue("f-peakPowerKw")).toBe("241"); // stock untouched
    fireEvent.click(runButton());
    const power = await metricRow(/Peak power/);
    expect(power.textContent).toMatch(/241[\s\S]*281[\s\S]*\+40/);
    const sixty = await metricRow(/0–60 mph/);
    const cells = sixty.querySelectorAll("td");
    expect(cells).toHaveLength(3);
    expect(cells[2].textContent).toMatch(/^−\d\.\d\d/);
  });

  it("unit switching preserves the underlying physical values", async () => {
    renderApp();
    await loadC300();
    fireEvent.click(screen.getByRole("radio", { name: "Metric" }));
    expect(fieldValue("f-peakPowerKw")).toBe("180"); // 241 hp = 179.7 kW
    expect(fieldValue("f-curbMassKg")).toBe("1550"); // 3417 lb
    fireEvent.click(screen.getByRole("radio", { name: "Imperial" }));
    expect(fieldValue("f-peakPowerKw")).toBe("241");
    expect(fieldValue("f-curbMassKg")).toBe("3417");
  });

  it("switching modes preserves inputs, and edits mark results out of date", async () => {
    renderApp();
    await loadC300();
    fireEvent.click(runButton());
    await metricRow(/0–60 mph/);
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Manual/ }));
    expect(fieldValue("f-peakPowerKw")).toBe("241");
    setField("f-peakPowerKw", "250");
    fireEvent.click(screen.getByRole("tab", { name: /Results/ }));
    expect(await screen.findByText(/computed for an earlier configuration/)).toBeTruthy();
  });

  it("changing vehicle never carries specifications from the previous one", async () => {
    renderApp();
    await loadC300();
    setField("f-curbMassKg", "3000");
    fireEvent.click(screen.getByRole("radio", { name: /Stock vs\. modified/ }));
    setField("d-peakPowerKw", "+40");
    await loadTrim("2018", "Toyota", "Camry", (o) => /^L 4dr Sedan/.test(o.text));
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(() => expect(screen.getAllByText(/2018 Toyota Camry/).length).toBeGreaterThan(0));
    const camry = allDatasetTrims().find((t) => t.year === 2018 && t.model === "Camry" && /^L 4dr Sedan/.test(t.description ?? ""))!;
    expect(fieldValue("f-curbMassKg")).toBe(String(camry.curbWeightLb));
    expect(fieldValue("f-peakPowerKw")).toBe(String(camry.hp));
    expect(screen.getByRole("radio", { name: "Stock only" }).getAttribute("aria-checked")).toBe("true");
  });
});

describe("Advanced Settings and validation", () => {
  it("advanced overrides feed the same engine and are labeled user-provided", async () => {
    renderApp();
    await loadC300();
    openAdvanced();
    setField("f-dragCoefficient", "0.25");
    fireEvent.click(runButton());
    await metricRow(/0–60 mph/);
    fireEvent.click(screen.getByRole("button", { name: /Inputs & provenance/ }));
    const inputs = screen.getByRole("table", { name: /Simulation inputs/ });
    const cd = within(inputs).getByRole("rowheader", { name: /Drag coefficient/ }).closest("tr")!;
    expect(cd.textContent).toMatch(/0\.250/);
    expect(cd.textContent).toMatch(/User/i);
  });

  it("blocks clearly invalid overrides and offers a one-click restore", async () => {
    renderApp();
    await loadC300();
    openAdvanced();
    setField("f-dragCoefficient", "423");
    setField("f-drivetrainEfficiency", "12");
    expect(runButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/2 invalid values must be fixed/)).toBeTruthy();
    const restoreButtons = () => {
      const alert = screen.queryAllByRole("alert").find((el) => el.textContent?.includes("must be fixed"));
      return alert ? within(alert).queryAllByRole("button", { name: /Use AutoDyn default/ }) : [];
    };
    expect(restoreButtons()).toHaveLength(2);
    while (restoreButtons().length) fireEvent.click(restoreButtons()[0]);
    await waitFor(() => expect(screen.getByText(/Ready — all inputs are valid/)).toBeTruthy());
    expect(runButton().hasAttribute("disabled")).toBe(false);
  });

  it("accepts percentages typed as fractions", async () => {
    renderApp();
    await loadC300();
    openAdvanced();
    setField("f-drivetrainEfficiency", "0.86");
    expect(fieldValue("f-drivetrainEfficiency")).toBe("86");
  });

  it("extreme but possible values warn and require confirmation instead of blocking", async () => {
    renderApp();
    await loadC300();
    setField("f-peakPowerKw", "1900");
    setField("f-peakTorqueNm", "2000"); // consistent with 1,900 hp at this engine's 5,550 rpm power peak
    expect(screen.queryByText(/must be fixed/)).toBeNull();
    expect(screen.getByText(/unusual values? — allowed after you confirm/)).toBeTruthy();
    expect(runButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByLabelText(/want to simulate them as entered/));
    expect(runButton().hasAttribute("disabled")).toBe(false);
  });

  it("defaults to standard conditions and flags non-standard ones with a reset", async () => {
    renderApp();
    await loadC300();
    expect(screen.getByText("Standard conditions")).toBeTruthy();
    openAdvanced();
    fireEvent.change(document.getElementById("c-surface")!, { target: { value: "snow" } });
    expect(screen.getByText("Non-standard conditions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset to standard" }));
    expect(screen.getByText("Standard conditions")).toBeTruthy();
  });

  it("does not restore state saved by earlier builds, and offers Start fresh for restored sessions", async () => {
    window.localStorage.setItem("autodyn:v2", JSON.stringify({ version: 2, config: { bogus: true } }));
    const { unmount } = renderApp();
    expect(screen.getByText(/Start by choosing a vehicle/)).toBeTruthy();
    await loadC300();
    await new Promise((r) => setTimeout(r, 400)); // persistence debounce
    unmount();
    renderApp();
    expect(await screen.findByText(/Restored your previous session/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    expect(screen.getByText(/Start by choosing a vehicle/)).toBeTruthy();
  });
});

describe("AI Build Assistant", () => {
  it("Describe → review → Apply runs the engine and posts computed results (nothing changes before Apply)", async () => {
    modelOutput = {
      intent: "compare",
      reply: "Found the 2015 C300 4MATIC. Review the change.",
      vehicle: { mentioned: true, year: 2015, make: "Mercedes-Benz", model: "C300", trim: "4MATIC" },
      useCurrentVehicle: false,
      changes: [{ scenario: "modified", field: "power", operation: "change", value: 40, unit: "hp", option: "", reason: "40 extra horsepower" }],
      view: "compare",
      runSimulation: true,
      followUpQuestion: null,
    };
    renderApp();
    const input = await openAssistant();
    expect(await screen.findByText("Connected")).toBeTruthy(); // probe route consulted
    fireEvent.change(input, { target: { value: "Compare my stock 2015 C300 4MATIC with 40 extra horsepower." } });
    fireEvent.click(screen.getByRole("button", { name: /Send message/ }));
    await screen.findAllByText(/Found the 2015 C300 4MATIC/, undefined, { timeout: 5000 });
    expect(assistantCalls).toBe(1);
    expect(screen.getByText(/No vehicle yet/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/241 hp → 281 hp/);
    fireEvent.click(screen.getAllByRole("button", { name: /Apply to Simulation/ })[0]);
    expect(await screen.findByText(/Physics engine results for 2015 Mercedes-Benz C300/, undefined, { timeout: 8000 })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /View results/ })[0]);
    const row = await metricRow(/Peak power/);
    expect(row.textContent).toMatch(/241[\s\S]*281/);
  });

  it("Cancel discards a proposal without touching the configuration", async () => {
    modelOutput = {
      intent: "modify",
      reply: "Prepared a +40 hp change.",
      vehicle: { mentioned: false, year: null, make: null, model: null, trim: null },
      useCurrentVehicle: true,
      changes: [{ scenario: "modified", field: "power", operation: "change", value: 40, unit: "hp", option: "", reason: "40 more hp" }],
      view: "compare",
      runSimulation: false,
      followUpQuestion: null,
    };
    renderApp();
    await loadC300();
    const input = await openAssistant();
    fireEvent.change(input, { target: { value: "Add 40 hp" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findAllByText(/Prepared a \+40 hp change/, undefined, { timeout: 5000 });
    fireEvent.click(screen.getAllByRole("button", { name: /^Cancel$/ })[0]);
    fireEvent.click(screen.getByRole("tab", { name: /Manual/ }));
    expect(screen.getByRole("radio", { name: "Stock only" }).getAttribute("aria-checked")).toBe("true");
  });

  it("explains which data is missing for an unknown vehicle and routes to manual entry", async () => {
    modelOutput = {
      intent: "analyze_vehicle",
      reply: "AutoDyn can't find verified specs for that model.",
      vehicle: { mentioned: true, year: 2015, make: "Yugo", model: "GV", trim: null },
      useCurrentVehicle: false,
      changes: [],
      view: "none",
      runSimulation: false,
      followUpQuestion: null,
    };
    renderApp();
    const input = await openAssistant();
    fireEvent.change(input, { target: { value: "Analyze a 2015 Yugo GV" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findAllByText(/peak power and curb weight/, undefined, { timeout: 5000 })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: /Enter specifications manually/ })[0]);
    expect(await screen.findByText("Key specifications")).toBeTruthy();
    expect(screen.getAllByText(/Peak power is required/).length).toBeGreaterThan(0);
  });

  it("shows the specific reason when AI isn't configured, and Manual Setup still simulates", async () => {
    aiConfigured = false;
    renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    expect(await screen.findByText("AI assistance is temporarily unavailable. Manual Setup is still ready to use.")).toBeTruthy();
    expect(screen.getByText(/Reason: AI assistance isn't configured on this deployment/)).toBeTruthy();
    expect(screen.getByText(/Deployment: preview · autodyn-v2 @ abc1234/)).toBeTruthy();
    expect((screen.getByLabelText(/Message the AI Build Assistant/) as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: /Open Manual Setup/ })[0]);
    fireEvent.click(screen.getByRole("radio", { name: /Enter manually/ }));
    fireEvent.change(screen.getByLabelText(/Vehicle name/), { target: { value: "Project car" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findAllByText(/Peak power is required/);
    setField("f-peakPowerKw", "300");
    setField("f-curbMassKg", "3200");
    fireEvent.change(document.getElementById("f-drivetrain")!, { target: { value: "RWD" } });
    fireEvent.click(runButton());
    expect((await metricRow(/0–60 mph/)).textContent).toMatch(/\d\.\d\d/);
  });
});

describe("vehicle loading states", () => {
  it("lookup failure shows a branded error with Retry and a direct manual path", async () => {
    failNhtsa = true;
    renderApp();
    await choose("sel-year", (o) => o.value === "2008");
    await choose("sel-make", (o) => o.value === "Honda");
    const alert = await screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert.getAttribute("data-stage")).toBe("error");
    expect(within(alert).getByRole("button", { name: /Retry/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Can't find it\? Enter the vehicle manually/ }));
    expect((screen.getByLabelText(/Vehicle name/) as HTMLInputElement).value).toBe("Honda");
    expect((screen.getByLabelText(/Year \(optional\)/) as HTMLInputElement).value).toBe("2008");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    setField("f-peakPowerKw", "140");
    setField("f-curbMassKg", "2700");
    fireEvent.change(document.getElementById("f-drivetrain")!, { target: { value: "FWD" } });
    fireEvent.click(runButton());
    expect((await metricRow(/0–60 mph/)).textContent).toMatch(/\d+\.\d\d/);
  });

  it("shows the manufacturer loader during a real request and a timeout error afterwards", async () => {
    hangModels = true;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp();
    await choose("sel-year", (o) => o.value === "2015");
    await choose("sel-make", (o) => o.value === "BMW");
    const status = await screen.findByText("Finding BMW models");
    expect(status.closest("[data-stage]")!.getAttribute("data-stage")).toBe("loading");
    await act(async () => {
      vi.advanceTimersByTime(12_500);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/taking too long/);
    hangModels = false;
    fireEvent.click(within(alert).getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect((document.getElementById("sel-model") as HTMLSelectElement).options.length).toBeGreaterThan(5));
  });

  it("brand marks: real logo when available, typographic fallback otherwise, AutoDyn when unknown", async () => {
    render(
      <>
        <BrandGlyph make="BMW" />
        <BrandGlyph make="Mercedes-Benz" />
        <BrandGlyph make={null} />
      </>,
    );
    await waitFor(() => expect(document.querySelector('[data-brand="BMW"]')).not.toBeNull());
    expect(document.querySelector('[data-brand="BMW"] path')!.getAttribute("d")!.length).toBeGreaterThan(50);
    expect(document.querySelector('[data-brand-fallback="Mercedes-Benz"]')!.textContent).toBe("Mercedes-Benz");
    expect(document.querySelector('[data-brand-fallback="AutoDyn"]')).not.toBeNull();
  });

  it("respects reduced motion (no spinning ring)", () => {
    reducedMotion = true;
    render(<LoadingStage make="Ford" label="Checking specifications" />);
    const stage = screen.getByRole("status");
    expect(stage.getAttribute("data-reduced-motion")).toBe("true");
    expect(stage.querySelector(".animate-ring")).toBeNull();
    cleanup();
    reducedMotion = false;
    render(<LoadingStage make="Ford" label="Checking specifications" />);
    expect(screen.getByRole("status").querySelector(".animate-ring")).not.toBeNull();
  });
});

describe("vehicle weight", () => {
  const weightTag = () => document.querySelector('[data-field="f-curbMassKg"]')!.querySelector("span.uppercase")!.textContent;
  const loadTlxWithoutWeight = () => loadTrim("2020", "Acura", "TLX", (o) => /SH-AWD PMC Edition/.test(o.text));

  it("sourced weight is populated automatically and labeled Verified", async () => {
    renderApp();
    await loadC300();
    expect(fieldValue("f-curbMassKg")).toBe("3417");
    expect(weightTag()).toBe("Verified");
    expect(screen.queryByTestId("weight-estimate")).toBeNull();
  });

  it("missing weight: run is blocked with a clear request; accepting the estimate runs the engine", async () => {
    renderApp();
    await loadTlxWithoutWeight();
    const card = await screen.findByTestId("weight-estimate");
    expect(card.textContent).toMatch(/No published curb weight/);
    expect(card.textContent).toMatch(/Median of \d+ other 2020 Acura TLX trim/);
    expect(fieldValue("f-curbMassKg")).toBe("");
    expect(weightTag()).toBe("Needed");
    expect(runButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText(/Vehicle weight is needed to simulate/).length).toBeGreaterThan(0);
    fireEvent.click(within(card).getByRole("button", { name: "Use estimated weight" }));
    expect(weightTag()).toBe("Estimated");
    expect(Number(fieldValue("f-curbMassKg"))).toBeGreaterThan(3400);
    expect(runButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(runButton());
    await metricRow(/0–60 mph/);
    fireEvent.click(screen.getByRole("button", { name: /Inputs & provenance/ }));
    const row = within(screen.getByRole("table", { name: /Simulation inputs/ })).getByRole("rowheader", { name: /Vehicle weight/ }).closest("tr")!;
    expect(row.textContent).toMatch(/Esti/);
  });

  it("the run panel offers the same estimate", async () => {
    renderApp();
    await loadTlxWithoutWeight();
    const alert = (await screen.findAllByRole("alert")).find((el) => el.textContent?.includes("must be fixed"))!;
    fireEvent.click(within(alert).getByRole("button", { name: /Use estimated weight \(≈/ }));
    expect(weightTag()).toBe("Estimated");
  });

  it("manual entry is labeled Manually entered and runs", async () => {
    renderApp();
    await loadTlxWithoutWeight();
    fireEvent.click(within(await screen.findByTestId("weight-estimate")).getByRole("button", { name: "Enter manually" }));
    expect(document.activeElement?.id).toBe("f-curbMassKg");
    setField("f-curbMassKg", "3,800");
    expect(fieldValue("f-curbMassKg")).toBe("3800");
    expect(weightTag()).toBe("Manually entered");
    fireEvent.click(runButton());
    expect((await metricRow(/0–60 mph/)).textContent).toMatch(/\d\.\d\d/);
  });

  it("custom vehicles get a class estimate only after the user picks a vehicle type", async () => {
    renderApp();
    fireEvent.click(screen.getByRole("radio", { name: /Enter manually/ }));
    fireEvent.change(screen.getByLabelText(/Vehicle name/), { target: { value: "Project car" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const card = await screen.findByTestId("weight-estimate");
    expect(within(card).queryByRole("button", { name: "Use estimated weight" })).toBeNull();
    setField("f-peakPowerKw", "300");
    fireEvent.change(document.getElementById("f-drivetrain")!, { target: { value: "RWD" } });
    expect(runButton().hasAttribute("disabled")).toBe(true); // no weight, no accepted estimate
    fireEvent.change(within(card).getByLabelText(/Vehicle type for weight estimate/), { target: { value: "car-mid" } });
    expect(card.textContent).toMatch(/Typical midsize car/);
    fireEvent.click(within(card).getByRole("button", { name: "Use estimated weight" }));
    expect(weightTag()).toBe("Estimated");
    expect(runButton().hasAttribute("disabled")).toBe(false);
  });

  it("a saved 1 lb weight from an older session is reset and reported", async () => {
    const trim = allDatasetTrims().find((t) => t.year === 2015 && t.model === "C300" && t.drive === "rear wheel drive" && /^C 300 4dr/.test(t.description ?? ""))!;
    const baseline = datasetTrimToSpecSet(trim);
    const stock = { ...baseline, values: { ...baseline.values, curbMassKg: { value: 0.4536, provenance: "user" } } };
    window.localStorage.setItem("autodyn:v3", JSON.stringify({ version: 3, config: { stock, modified: null, conditions: DEFAULT_CONDITIONS }, baseline, units: "imperial", messages: [] }));
    renderApp();
    expect(await screen.findByText(/1 saved value was physically invalid and reset/)).toBeTruthy();
    expect(fieldValue("f-curbMassKg")).toBe("3417");
    expect(weightTag()).toBe("Verified");
    expect(runButton().hasAttribute("disabled")).toBe(false);
  });

  it("a weight typed now that is impossible is blocked with a restore action", async () => {
    renderApp();
    await loadC300();
    setField("f-curbMassKg", "1");
    expect(runButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText(/not a realistic curb weight/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Restore published weight \(3417 lb\)/ }));
    expect(fieldValue("f-curbMassKg")).toBe("3417");
    expect(runButton().hasAttribute("disabled")).toBe(false);
  });

  it("reset and vehicle switching never keep another vehicle's weight", async () => {
    renderApp();
    await loadC300();
    setField("f-curbMassKg", "3300");
    fireEvent.click(screen.getByRole("button", { name: /Reset configuration/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(fieldValue("f-curbMassKg")).toBe("3417");
    setField("f-curbMassKg", "3300");
    await loadTlxWithoutWeight();
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await screen.findByTestId("weight-estimate");
    expect(fieldValue("f-curbMassKg")).toBe("");
  });

  it("modified weight changes physics without touching stock, and follows stock corrections", async () => {
    renderApp();
    await loadC300();
    fireEvent.click(screen.getByRole("radio", { name: /Stock vs\. modified/ }));
    setField("d-curbMassKg", "-150");
    expect(document.getElementById("d-curbMassKg-hint")!.textContent).toMatch(/Modified: 3267 lb · Stock: 3417 lb/);
    expect(fieldValue("f-curbMassKg")).toBe("3417");
    setField("f-curbMassKg", "3500");
    expect(document.getElementById("d-curbMassKg-hint")!.textContent).toMatch(/Modified: 3350 lb · Stock: 3500 lb/);
    fireEvent.click(runButton());
    const row = await metricRow(/Test mass/);
    expect(row.textContent).toMatch(/3,676[\s\S]*3,526[\s\S]*−150/); // + 176 lb driver
  });

  it("weight converts between imperial and metric without changing the stored mass", async () => {
    renderApp();
    await loadTlxWithoutWeight();
    const card = await screen.findByTestId("weight-estimate");
    const lbText = card.textContent!.match(/≈ ([\d,]+) lb/)![1];
    fireEvent.click(screen.getByRole("radio", { name: "Metric" }));
    const kgText = screen.getByTestId("weight-estimate").textContent!.match(/≈ ([\d,]+) kg/)![1];
    expect(Number(kgText.replace(/,/g, "")) / 0.45359237).toBeCloseTo(Number(lbText.replace(/,/g, "")), -1);
    fireEvent.click(within(screen.getByTestId("weight-estimate")).getByRole("button", { name: "Use estimated weight" }));
    const kg = Number(fieldValue("f-curbMassKg"));
    fireEvent.click(screen.getByRole("radio", { name: "Imperial" }));
    expect(Number(fieldValue("f-curbMassKg"))).toBeCloseTo(kg / 0.45359237, -1);
  });
});

describe("feasibility and semantic colors", () => {
  async function runCompare(power = "+40") {
    renderApp();
    await loadC300();
    fireEvent.click(screen.getByRole("radio", { name: /Stock vs\. modified/ }));
    setField("d-peakPowerKw", power);
    fireEvent.click(runButton());
    await metricRow(/0–60 mph/);
  }

  it("Results show Stock Feasible and Modified Questionable with text labels and reasons", async () => {
    await runCompare();
    const stock = screen.getByTestId("feasibility-stock");
    const mod = screen.getByTestId("feasibility-modified");
    expect(stock.querySelector("[data-feasibility]")!.getAttribute("data-feasibility")).toBe("feasible");
    expect(stock.textContent).toMatch(/Feasible within modeled constraints/);
    expect(mod.querySelector("[data-feasibility]")!.getAttribute("data-feasibility")).toBe("questionable");
    expect(mod.textContent).toMatch(/Requires further verification/);
    expect(mod.textContent).toMatch(/no component ratings available/);
    // Scenario identity (blue/orange + shape + text) is separate from the status color.
    expect(stock.querySelector('[data-scenario="stock"]')!.className).toMatch(/text-stock/);
    expect(mod.querySelector('[data-scenario="modified"]')!.className).toMatch(/text-modified/);
    expect(mod.querySelector("[data-feasibility]")!.className).toMatch(/text-questionable/);
  });

  it("View Engineering Assessment expands constraints, inputs, assumptions and missing information", async () => {
    await runCompare();
    const mod = screen.getByTestId("feasibility-modified");
    const toggle = within(mod).getByRole("button", { name: /View Engineering Assessment/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const driveline = mod.querySelector('[data-check="mechanical.driveline"]')!;
    expect(driveline.getAttribute("data-outcome")).toBe("caution");
    expect(driveline.textContent).toMatch(/Needs verification/);
    expect(within(mod).getByText("Inputs evaluated")).toBeTruthy();
    expect(within(mod).getByText("Missing information")).toBeTruthy();
    expect(mod.textContent).toMatch(/Drivetrain torque rating/);
  });

  it("a claim entered in Advanced Settings that breaks the traction limit is Non-feasible with the reason", async () => {
    renderApp();
    await loadC300();
    openAdvanced();
    setField("k-claimedZeroTo60S", "2.0");
    fireEvent.click(runButton());
    await metricRow(/0–60 mph/);
    const stock = screen.getByTestId("feasibility-stock");
    expect(stock.querySelector("[data-feasibility]")!.getAttribute("data-feasibility")).toBe("non_feasible");
    expect(stock.textContent).toMatch(/Conflicts with modeled constraints/);
    expect(stock.textContent).toMatch(/needs an average 1\.37 g/);
  });

  it("chart legends use Stock blue and Modified orange, with labeled traction-limit lines", async () => {
    await runCompare();
    // jsdom does not lay out the animated line paths; legends carry the same series colors.
    // (Line strokes and dash patterns are verified in the real-browser e2e test.)
    const icons = [...document.querySelectorAll(".recharts-legend-icon")].map((p) => `${p.getAttribute("stroke") ?? ""}${p.getAttribute("fill") ?? ""}`.toUpperCase());
    expect(icons.some((c) => c.includes("#79A7FF"))).toBe(true);
    expect(icons.some((c) => c.includes("#E87942"))).toBe(true);
    expect(document.body.textContent).not.toMatch(/#8FA7BD|#D46A2C/i);
    expect(document.body.textContent).toMatch(/Stock traction limit \d\.\d\d g/);
  });

  it("invalid inputs are red errors; unusual inputs are amber warnings", async () => {
    renderApp();
    await loadC300();
    openAdvanced();
    setField("f-dragCoefficient", "423");
    const cd = document.getElementById("f-dragCoefficient")!;
    expect(cd.className).toMatch(/border-error/);
    const cdMsg = document.getElementById("f-dragCoefficient-hint")!.querySelector(".text-error");
    expect(cdMsg!.textContent).toMatch(/^Invalid:/);
    fireEvent.click(screen.getAllByRole("button", { name: /Use AutoDyn default/ })[0]);
    setField("f-peakPowerKw", "1900");
    setField("f-peakTorqueNm", "2000");
    const warn = document.getElementById("f-peakPowerKw-hint")!.querySelector(".text-warning");
    expect(warn!.textContent).toMatch(/^Unusual:/);
    expect(document.getElementById("f-peakPowerKw")!.className).not.toMatch(/border-error/);
  });

  it("editing an input after a run marks feasibility and results stale", async () => {
    await runCompare();
    fireEvent.click(screen.getByRole("tab", { name: /Manual/ }));
    setField("d-peakPowerKw", "+60");
    fireEvent.click(screen.getByRole("tab", { name: /Results/ }));
    expect(await screen.findByText(/computed for an earlier configuration/)).toBeTruthy();
  });
});

describe("AI diagnostics display", () => {
  it("shows the exact provider failure, HTTP status and configuration notes without secrets", async () => {
    routes["/api/assistant"] = async () =>
      Response.json({
        configured: true,
        model: "gemini-3.5-flash-lite",
        deployment: { ...deployment, project: "auto-dyn-performance.vercel.app" },
        provider: { status: "model_unavailable", model: "gemini-3.5-flash-lite", httpStatus: 404, reason: "NOT_FOUND", checkedAt: new Date().toISOString(), latencyMs: 210, source: "probe" },
        configNotes: ["GEMINI_MODEL normalized to “gemini-3.5-flash-lite”."],
      });
    renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    expect(await screen.findByText("AI assistance is temporarily unavailable. Manual Setup is still ready to use.")).toBeTruthy();
    expect(screen.getByText(/wasn't found for this API project/)).toBeTruthy();
    expect(screen.getByText(/provider response: HTTP 404 · NOT_FOUND/)).toBeTruthy();
    expect(screen.getByText(/Configuration: GEMINI_MODEL normalized/)).toBeTruthy();
    expect(screen.getByText(/auto-dyn-performance\.vercel\.app · autodyn-v2 @ abc1234/)).toBeTruthy();
    expect((screen.getByLabelText(/Message the AI Build Assistant/) as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe("rendering", () => {
  it("keyboard arrows move between workspaces", () => {
    renderApp();
    const manual = screen.getByRole("tab", { name: /Manual/ });
    manual.focus();
    fireEvent.keyDown(manual, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Assistant/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("server-renders and hydrates without mismatches", async () => {
    const html = renderToString(
      <AppProvider>
        <AppShell />
      </AppProvider>,
    );
    expect(html).toMatch(/Manual Setup/);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a));
    await act(async () => {
      hydrateRoot(
        container,
        <AppProvider>
          <AppShell />
        </AppProvider>,
        { onRecoverableError: (e) => errors.push(e) },
      );
    });
    spy.mockRestore();
    expect(errors).toEqual([]);
    container.remove();
  });
});
