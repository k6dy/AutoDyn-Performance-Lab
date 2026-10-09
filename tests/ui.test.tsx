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
import { handleAssistantRequest } from "@/lib/ai/handler";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import type { ModelOutput } from "@/lib/ai/schema";
import { allDatasetTrims } from "@/lib/vehicles/dataset.server";
import { AppProvider } from "@/state/AppProvider";

type Handler = (req: Request) => Promise<Response> | Response;

let aiAvailable = true;
let modelOutput: ModelOutput | null = null;
let failNhtsa = false;
let assistantCalls = 0;

const routes: Record<string, Handler> = {
  "/api/vehicles/makes": makesRoute,
  "/api/vehicles/models": async (req) => {
    if (failNhtsa && !/year=20(1[5-9]|20)/.test(req.url)) return Response.json({ error: "NHTSA vPIC did not respond. Retry, or enter the vehicle as a custom vehicle.", retryable: true }, { status: 502 });
    return modelsRoute(req);
  },
  "/api/vehicles/trims": trimsRoute,
  "/api/vehicles/spec": specRoute,
  "/api/assistant": async (req) => {
    if (req.method === "GET") return Response.json({ available: aiAvailable, model: aiAvailable ? "test-model" : null });
    assistantCalls += 1;
    const result = await handleAssistantRequest(await req.json(), {
      configured: aiAvailable,
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

beforeEach(() => {
  aiAvailable = true;
  modelOutput = null;
  failNhtsa = false;
  assistantCalls = 0;
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://test");
      const handler = routes[url.pathname];
      if (!handler) throw new Error(`Unexpected fetch ${url}`);
      return handler(new Request(url, init));
    }),
  );
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
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
  const select = (await waitFor(() => {
    const el = document.getElementById(id) as HTMLSelectElement;
    if (el.disabled) throw new Error(`${id} not ready`);
    if (![...el.options].some(predicate)) throw new Error(`${id} options not loaded`);
    return el;
  }, { timeout: 5000 })) as HTMLSelectElement;
  const option = [...select.options].find(predicate)!;
  fireEvent.change(select, { target: { value: option.value } });
}

async function loadC300() {
  await choose("sel-year", (o) => o.value === "2015");
  await choose("sel-make", (o) => o.value === "Mercedes-Benz");
  await choose("sel-model", (o) => o.value === "C300");
  await choose("sel-trim", (o) => /^C 300 4dr Sedan/.test(o.text) && /rear wheel drive/.test(o.text));
  await screen.findAllByRole("button", { name: /Run analysis/ }, { timeout: 5000 });
}

// The desktop run panel and the mobile run bar both render in jsdom (no CSS); use the panel's.
const runButton = () => screen.getAllByRole("button", { name: /Run analysis/ })[0];

function setField(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

async function metricCell(label: RegExp) {
  const table = await screen.findByRole("table", { name: /Computed performance metrics/ }, { timeout: 8000 });
  return within(table).getByRole("rowheader", { name: label }).closest("tr")!;
}

describe("workflow 1 & 2 — Manual Setup", () => {
  it("Stock → Run analysis → Results with engine-computed values", async () => {
    renderApp();
    await loadC300();
    expect((document.getElementById("f-peakPowerKw") as HTMLInputElement).value).toBe("241");
    fireEvent.click(runButton());
    const row = await metricCell(/0–60 mph/);
    expect(row.textContent).toMatch(/\d\.\d\d/);
    expect(screen.getByRole("tab", { name: /Results/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("Modified → Compare shows both scenarios and a difference; Stock is preserved", async () => {
    renderApp();
    await loadC300();
    fireEvent.click(screen.getByRole("button", { name: /Create modified scenario/ }));
    setField("f-peakPowerKw", "281");
    setField("f-curbMassKg", "3399");
    expect(screen.getByText(/Stock: 241 hp/)).toBeTruthy();
    fireEvent.click(runButton());
    const row = await metricCell(/Peak power/);
    expect(row.textContent).toMatch(/241/);
    expect(row.textContent).toMatch(/281/);
    expect(row.textContent).toMatch(/\+40/);
    const sixty = await metricCell(/0–60 mph/);
    const cells = sixty.querySelectorAll("td");
    expect(cells).toHaveLength(3);
    expect(cells[2].textContent).toMatch(/^−\d\.\d\d/); // modified is quicker
    expect(cells[2].querySelector(".text-gain")).not.toBeNull();
  });

  it("switching modes preserves inputs, and edits mark results out of date", async () => {
    renderApp();
    await loadC300();
    fireEvent.click(runButton());
    await metricCell(/0–60 mph/);
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Manual/ }));
    expect((document.getElementById("f-peakPowerKw") as HTMLInputElement).value).toBe("241");
    setField("f-tireMu", "1.1");
    fireEvent.click(screen.getByRole("tab", { name: /Results/ }));
    expect(await screen.findByText(/computed for an earlier configuration/)).toBeTruthy();
  });

  it("keyboard arrows move between workspaces", async () => {
    renderApp();
    const manual = screen.getByRole("tab", { name: /Manual/ });
    manual.focus();
    fireEvent.keyDown(manual, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Assistant/ }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("workflow 3 — AI Build Assistant", () => {
  it("Describe → review proposal → Apply → simulate → Results (no change before Apply)", async () => {
    modelOutput = {
      intent: "analyze_vehicle",
      reply: "I found the 2015 C300 4MATIC in AutoDyn's dataset. Review and apply to run it.",
      vehicle: { year: 2015, make: "Mercedes-Benz", model: "C300", trim: "4MATIC" },
      useCurrentVehicle: false,
      changes: [],
      view: "stock",
      runSimulation: true,
      followUpQuestion: null,
    };
    renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    const input = await screen.findByLabelText(/Message the AI Build Assistant/);
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "Analyze a stock 2015 Mercedes-Benz C300 4MATIC." } });
    fireEvent.click(screen.getByRole("button", { name: /Send message/ }));
    await screen.findAllByText(/found the 2015 C300 4MATIC/, undefined, { timeout: 5000 });
    expect(assistantCalls).toBe(1);
    // Nothing applied yet.
    expect(screen.getByText(/No vehicle yet/)).toBeTruthy();
    const apply = screen.getAllByRole("button", { name: /Apply to simulation/ })[0];
    fireEvent.click(apply);
    await waitFor(() => expect(screen.queryByText(/No vehicle yet/)).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /Results/ }));
    const row = await metricCell(/0–60 mph/);
    expect(row.textContent).toMatch(/\d\.\d\d/);
    expect(screen.getAllByText(/2015 Mercedes-Benz C300/).length).toBeGreaterThan(0);
  });

  it("Cancel discards a proposal without touching the configuration", async () => {
    modelOutput = {
      intent: "modify",
      reply: "Proposed +40 hp.",
      vehicle: null,
      useCurrentVehicle: true,
      changes: [{ scenario: "modified", field: "power", operation: "change", value: 40, unit: "hp", option: "", reason: "40 more hp" }],
      view: "compare",
      runSimulation: false,
      followUpQuestion: null,
    };
    renderApp();
    await loadC300();
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    const input = await screen.findByLabelText(/Message the AI Build Assistant/);
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "Add 40 hp" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findAllByText(/Proposed \+40 hp/, undefined, { timeout: 5000 });
    fireEvent.click(screen.getAllByRole("button", { name: /^Cancel$/ })[0]);
    fireEvent.click(screen.getByRole("tab", { name: /Manual/ }));
    expect(screen.getByRole("button", { name: /Create modified scenario/ })).toBeTruthy();
  });
});

describe("workflow 4 & 5 — fallbacks", () => {
  it("AI unavailable → Manual Setup custom vehicle → successful simulation", async () => {
    aiAvailable = false;
    renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Assistant/ }));
    expect(await screen.findByText("AI assistance is temporarily unavailable. Manual Setup is still ready to use.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Open Manual Setup/ })[0]);
    fireEvent.click(screen.getByRole("radio", { name: /Custom vehicle/ }));
    fireEvent.change(screen.getByLabelText(/Vehicle name/), { target: { value: "Project car" } });
    fireEvent.click(screen.getByRole("button", { name: /Create custom vehicle/ }));
    await screen.findAllByText(/Peak power is required/);
    setField("f-peakPowerKw", "300");
    setField("f-curbMassKg", "3200");
    fireEvent.change(document.getElementById("f-drivetrain")!, { target: { value: "RWD" } });
    fireEvent.click(runButton());
    const row = await metricCell(/0–60 mph/);
    expect(row.textContent).toMatch(/\d\.\d\d/);
  });

  it("vehicle lookup failure shows retry and a manual path that still simulates", async () => {
    failNhtsa = true;
    renderApp();
    await choose("sel-year", (o) => o.value === "2008");
    await choose("sel-make", (o) => o.value === "Honda");
    expect(await screen.findByText(/did not respond/, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Custom vehicle/ }));
    fireEvent.change(screen.getByLabelText(/Vehicle name/), { target: { value: "Honda Civic" } });
    fireEvent.change(screen.getByLabelText(/Year \(optional\)/), { target: { value: "2008" } });
    fireEvent.click(screen.getByRole("button", { name: /Create custom vehicle/ }));
    setField("f-peakPowerKw", "140");
    setField("f-curbMassKg", "2700");
    fireEvent.change(document.getElementById("f-drivetrain")!, { target: { value: "FWD" } });
    fireEvent.click(runButton());
    const row = await metricCell(/0–60 mph/);
    expect(row.textContent).toMatch(/\d+\.\d\d/);
  });
});

describe("rendering", () => {
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
      hydrateRoot(container, (
        <AppProvider>
          <AppShell />
        </AppProvider>
      ), { onRecoverableError: (e) => errors.push(e) });
    });
    spy.mockRestore();
    expect(errors).toEqual([]);
    container.remove();
  });
});
