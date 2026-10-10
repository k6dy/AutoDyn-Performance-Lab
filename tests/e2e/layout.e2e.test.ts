// Real-browser checks against the production build (`npm run build` first).
// A locally installed Chromium-family browser (Edge/Chrome) is driven headlessly; every request is
// fulfilled in-process from `.next/` and the real route handlers — no server or port is started.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as assistantGet, POST as assistantPost } from "@/app/api/assistant/route";
import { GET as healthGet } from "@/app/api/assistant/health/route";
import { handleAssistantRequest } from "@/lib/ai/handler";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import type { ModelOutput } from "@/lib/ai/schema";
import { allDatasetTrims } from "@/lib/vehicles/dataset.server";
import { GET as makes } from "@/app/api/vehicles/makes/route";
import { GET as models } from "@/app/api/vehicles/models/route";
import { GET as spec } from "@/app/api/vehicles/spec/route";
import { GET as trims } from "@/app/api/vehicles/trims/route";

const ROOT = process.cwd();
const NEXT = path.join(ROOT, ".next");
const ORIGIN = "https://autodyn.test";
const built = fs.existsSync(path.join(NEXT, "server/app/index.html"));

const MIME: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };
type RouteFn = (req: Request) => Promise<Response> | Response;
const API: Record<string, { GET?: RouteFn; POST?: RouteFn }> = {
  "/api/vehicles/makes": { GET: makes },
  "/api/vehicles/models": { GET: models },
  "/api/vehicles/trims": { GET: trims },
  "/api/vehicles/spec": { GET: spec },
  "/api/assistant": { GET: () => assistantGet(), POST: assistantPost },
  "/api/assistant/health": { GET: healthGet },
};

async function launch(): Promise<Browser | null> {
  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try next channel
    }
  }
  return null;
}

let browser: Browser | null = null;

beforeAll(async () => {
  if (built) browser = await launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function newPage(width: number, opts: { reducedMotion?: "reduce" | "no-preference" } = {}): Promise<{ page: Page; ctx: BrowserContext; logs: string[] }> {
  const ctx = await browser!.newContext({ viewport: { width, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: opts.reducedMotion ?? "no-preference" });
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: fs.readFileSync(path.join(NEXT, "server/app/index.html"), "utf8") });
    if (url.pathname.startsWith("/_next/static/")) {
      const file = path.join(NEXT, "static", decodeURIComponent(url.pathname.slice("/_next/static/".length)));
      if (!file.startsWith(path.join(NEXT, "static")) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
    }
    const handler = API[url.pathname]?.[req.method() as "GET" | "POST"];
    if (handler) {
      const res = await handler(new Request(url, { method: req.method(), headers: req.headers(), body: req.method() === "POST" ? req.postData() : undefined }));
      return route.fulfill({ status: res.status, contentType: res.headers.get("content-type") ?? "application/json", body: Buffer.from(await res.arrayBuffer()) });
    }
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204, body: "" });
    return route.fulfill({ status: 404, body: "" });
  });
  const page = await ctx.newPage();
  const logs: string[] = [];
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${ORIGIN}/`);
  return { page, ctx, logs };
}

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string, fullPage = false) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
};

// Compare against the emulated device width: on phones, overflowing content widens the layout
// viewport (innerWidth grows), which would otherwise hide the overflow.
const overflow = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth, window.innerWidth) - screen.width);

async function pick(page: Page, id: string, match: (text: string, value: string) => boolean) {
  await page.waitForFunction(
    ([sel, src]) => {
      const el = document.getElementById(sel) as HTMLSelectElement | null;
      if (!el || el.disabled) return false;
      const fn = new Function("t", "v", `return (${src})(t, v)`) as (t: string, v: string) => boolean;
      return [...el.options].some((o) => fn(o.text, o.value));
    },
    [id, match.toString()] as const,
    { timeout: 10_000 },
  );
  const value = await page.$eval(
    `#${id}`,
    (el, src) => {
      const fn = new Function("t", "v", `return (${src})(t, v)`) as (t: string, v: string) => boolean;
      return [...(el as HTMLSelectElement).options].find((o) => fn(o.text, o.value))!.value;
    },
    match.toString(),
  );
  await page.selectOption(`#${id}`, value);
}

const suite = built ? describe : describe.skip;

suite.each([360, 390])("production build at %ipx", (width) => {
  it("Basic Setup → results without horizontal overflow; Run stays reachable; no console errors", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found for playwright-core (channel msedge/chrome).");
    const { page, ctx, logs } = await newPage(width);
    try {
      await page.getByText("Start by choosing a vehicle").waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await pick(page, "sel-year", (_t, v) => v === "2015");
      await pick(page, "sel-make", (_t, v) => v === "Mercedes-Benz");
      await pick(page, "sel-model", (_t, v) => v === "C300");
      await pick(page, "sel-trim", (t) => t.startsWith("C 300 4dr Sedan") && t.includes("rear wheel drive"));
      await page.getByText("Key specifications").waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, `${width}-basic`, true);

      // Mobile run bar is visible inside the viewport without scrolling.
      const bar = page.getByRole("button", { name: "Run analysis (mobile)" });
      await expect(bar.isVisible()).resolves.toBe(true);
      const box = (await bar.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(780);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);

      await page.getByRole("radio", { name: "Stock vs. modified" }).click();
      await page.fill("#d-peakPowerKw", "+40");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: /Advanced Settings/ }).click();
      await page.locator("#f-dragCoefficient").waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, `${width}-viewport`);

      await bar.click();
      await page.getByRole("table", { name: "Computed performance metrics" }).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(900); // chart entry animation
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, `${width}-results`, true);
      const charts = await page.locator("svg.recharts-surface").count();
      expect(charts).toBeGreaterThanOrEqual(5);
      // Scenario colors and dash patterns on the actual rendered lines.
      const lines = await page.$$eval("path.recharts-line-curve", (ps) => ps.map((p) => [p.getAttribute("stroke")?.toUpperCase(), p.getAttribute("stroke-dasharray")]));
      expect(lines.some(([c, d]) => c === "#79A7FF" && (!d || d === "none" || /^0px/.test(d) === false))).toBe(true);
      expect(lines.some(([c]) => c === "#E87942")).toBe(true);
      await page.getByTestId("feasibility-modified").waitFor();
      expect(await page.getByTestId("feasibility-modified").getAttribute("class")).toMatch(/border-questionable/);

      await page.getByRole("tab", { name: /Assistant/ }).click();
      await page.getByLabel("Message the AI Build Assistant").waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, `${width}-assistant`);

      const relevant = logs.filter((l) => !/favicon/i.test(l));
      expect(relevant).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});

suite.each([360, 390])("missing vehicle weight at %ipx", (width) => {
  it("shows the estimate card without overflow; accepting it enables Run and produces results", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    const { page, ctx, logs } = await newPage(width);
    try {
      await pick(page, "sel-year", (_t, v) => v === "2020");
      await pick(page, "sel-make", (_t, v) => v === "Acura");
      await pick(page, "sel-model", (_t, v) => v === "TLX");
      await pick(page, "sel-trim", (t) => t.includes("SH-AWD PMC Edition"));
      const card = page.getByTestId("weight-estimate");
      await card.waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const bar = page.getByRole("button", { name: "Run analysis (mobile)" });
      expect(await bar.isDisabled()).toBe(true);
      await page.locator('button[aria-label="About vehicle weight"]').focus();
      expect(await overflow(page)).toBeLessThanOrEqual(0); // tooltip open
      await card.getByRole("button", { name: "Use estimated weight" }).click();
      expect(await bar.isDisabled()).toBe(false);
      await bar.click();
      await page.getByRole("table", { name: "Computed performance metrics" }).waitFor({ timeout: 15_000 });
      expect(logs.filter((l) => !/favicon/i.test(l))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});

suite.each([360, 390])("saved analyses at %ipx", (width) => {
  it("auto-saves, survives a reload, reopens and resets — without overflow or console errors", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    const { page, ctx, logs } = await newPage(width);
    try {
      await pick(page, "sel-year", (_t, v) => v === "2015");
      await pick(page, "sel-make", (_t, v) => v === "Mercedes-Benz");
      await pick(page, "sel-model", (_t, v) => v === "C300");
      await pick(page, "sel-trim", (t) => t.startsWith("C 300 4dr Sedan") && t.includes("rear wheel drive"));
      await page.getByRole("button", { name: "Run analysis (mobile)" }).click();
      await page.getByRole("table", { name: "Computed performance metrics" }).waitFor({ timeout: 15_000 });
      await page.getByText(/Saved as/).first().waitFor();
      const newAnalysis = page.getByTestId("new-analysis").first();
      expect(await newAnalysis.isVisible()).toBe(true);
      await page.waitForTimeout(400); // draft autosave debounce

      await page.reload(); // same browser profile → same IndexedDB
      await page.getByRole("button", { name: "Continue last session" }).waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, `${width}-draft-offer`);
      await page.getByRole("button", { name: "Start fresh" }).click();
      await page.getByRole("tab", { name: /Saved/ }).click();
      const row = page.getByTestId("saved-row").first();
      await row.waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, `${width}-saved`, true);

      await row.getByRole("button", { name: /^Rename / }).click();
      await page.getByRole("dialog", { name: "Rename analysis" }).waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");

      await row.getByRole("button", { name: /^Open / }).click();
      await page.getByRole("table", { name: "Computed performance metrics" }).waitFor({ timeout: 15_000 });
      await page.getByText(/Saved snapshot from/).waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      await page.getByTestId("new-analysis").first().click();
      await page.getByText("Start by choosing a vehicle").waitFor();
      await page.getByRole("tab", { name: /Saved/ }).click();
      expect(await page.getByTestId("saved-row").count()).toBe(1); // history kept after reset
      expect(logs.filter((l) => !/favicon/i.test(l))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});

async function mockAssistant(page: Page, reply = "A turbocharger uses exhaust energy to spin a compressor that forces more air into the engine.") {
  let posts = 0;
  const status = { configured: true, model: "gemini-3.5-flash-lite", deployment: { environment: "preview", branch: "autodyn-v2", commit: "abc1234" }, provider: { status: "ok", model: "gemini-3.5-flash-lite", checkedAt: new Date().toISOString(), latencyMs: 5, source: "access" } };
  await page.route(/\/api\/assistant(\/health)?(\?.*)?$/, async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
    posts += 1;
    const body = JSON.parse(req.postData() ?? "{}");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, requestId: body.requestId, reply, followUpQuestion: null, proposal: null, suggestedAction: null, notices: [] }),
    });
  });
  return () => posts;
}

async function send(page: Page, text: string) {
  const input = page.getByLabel("Message the AI Build Assistant");
  await input.fill(text);
  await input.press("Enter");
}

suite.each([360, 390])("automotive assistant at %ipx", (width) => {
  it("local rejection without a request, history drawer, usable composer, no overflow", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    const { page, ctx, logs } = await newPage(width);
    try {
      const posts = await mockAssistant(page);
      await page.getByRole("tab", { name: /Assistant/ }).click();
      await page.getByText("Ask about cars, parts or your build").waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await send(page, "Do cows hibernate?");
      await page.getByText("I'm here for cars, parts, and vehicle performance. Ask me something automotive-related.").waitFor();
      expect(posts()).toBe(0);
      await send(page, "How does a turbocharger work?");
      await page.getByText(/exhaust energy to spin a compressor/).waitFor();
      expect(posts()).toBe(1);
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      // Composer stays usable: visible, inside the viewport width, focusable.
      const composer = page.getByLabel("Message the AI Build Assistant");
      await composer.scrollIntoViewIfNeeded();
      const box = (await composer.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      await shot(page, `${width}-chat`);

      await page.getByRole("button", { name: "Open chat history" }).click();
      const drawer = page.getByRole("dialog", { name: "Chat history" });
      await drawer.waitFor();
      await drawer.getByTestId("chat-item").first().waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.waitForTimeout(300); // drawer slide-in
      await shot(page, `${width}-chat-drawer`);
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "detached" });
      expect(logs.filter((l) => !/favicon/i.test(l))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});

suite("conversation context in a real browser", () => {
  it("clarifies locally, then sends the follow-up with the established subject (390px)", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    const { page, ctx, logs } = await newPage(390);
    try {
      const posts = await mockAssistant(page);
      await page.getByRole("tab", { name: /Assistant/ }).click();
      await send(page, "do jaguars like to pur?");
      await page.getByText("Do you mean Jaguar cars or the animal?").waitFor();
      expect(posts()).toBe(0);
      await send(page, "the v8 jaguar");
      await page.getByText(/exhaust energy to spin a compressor/).first().waitFor();
      expect(posts()).toBe(1);
      await send(page, "what models are there?");
      await page.waitForFunction(() => document.querySelectorAll('[data-message-role="assistant"]').length >= 3);
      expect(posts()).toBe(2);
      expect(await page.getByText(/Which vehicle, part or system do you mean/).count()).toBe(0);
      expect(await page.getByTestId("chat-subject").textContent()).toMatch(/Jaguar · V8/);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await send(page, "Do cows hibernate?");
      await page.getByText("I'm here for cars, parts, and vehicle performance. Ask me something automotive-related.").waitFor();
      expect(posts()).toBe(2);
      expect(logs.filter((l) => !/favicon/i.test(l))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});

const FORMATTED = [
  "They do different jobs, so neither replaces the other.",
  "",
  "### 1. Wastegate",
  "Sits on the **exhaust** side and bypasses gas around the turbine to cap boost at the target pressure.",
  "",
  "### 2. Blow-off valve",
  "- Sits on the **intake** side",
  "- Vents pressurized air when the throttle closes",
  "- Protects the compressor from surge",
  "",
  "### 3. Which matters more?",
  "| Component | Side | Without it | Typical failure symptom |",
  "|---|---|---|---|",
  "| Wastegate | Exhaust turbine housing | Boost rises uncontrolled (overboost) | Boost spikes, limp mode, knock |",
  "| Blow-off valve | Intake charge pipe | Compressor surge on lift-off | Flutter noise, slower spool-up |",
  "",
  '<img src="x" onerror="window.__xss=1"><script>window.__xss=2</script>',
].join("\n");

suite.each([360, 1366])("formatted assistant answers at %ipx", (width) => {
  it("render headings, lists and a contained table; survive a reload; never execute markup", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    const { page, ctx, logs } = await newPage(width);
    try {
      if (width > 1000) await page.setViewportSize({ width, height: 900 });
      await mockAssistant(page, FORMATTED);
      await page.getByRole("tab", { name: /Assistant/ }).first().click();
      await send(page, "What's a wastegate, what's a blow-off valve, and which one is more important?");
      const answer = page.locator('[data-message-role="assistant"] [data-markdown]').last();
      await answer.locator("h3").nth(2).waitFor();
      const check = async () => {
        expect(await answer.locator("h3").allTextContents()).toEqual(["1. Wastegate", "2. Blow-off valve", "3. Which matters more?"]);
        expect(await answer.locator("ul > li").count()).toBe(3);
        expect(await answer.locator("[data-md-table] th").count()).toBe(4);
        expect(await answer.locator("img, script").count()).toBe(0);
        expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
        const vw = width > 1000 ? await page.evaluate(() => window.innerWidth) : width;
        expect(await (width > 1000 ? page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) : overflow(page))).toBeLessThanOrEqual(0);
        const region = (await answer.locator("[data-md-table]").boundingBox())!;
        expect(region.x).toBeGreaterThanOrEqual(0);
        expect(region.x + region.width).toBeLessThanOrEqual(vw);
        // Paragraph spacing is real: consecutive blocks don't touch.
        const gaps = await answer.evaluate((el) => {
          const kids = [...el.children].map((c) => c.getBoundingClientRect());
          return kids.slice(1).map((r, i) => r.top - kids[i].bottom);
        });
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(8);
      };
      await check();
      if (width < 1000) {
        // The wide table scrolls inside its own box on phones.
        expect(await answer.locator("[data-md-table]").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      }
      await answer.scrollIntoViewIfNeeded();
      await shot(page, `${width}-formatted-answer`);

      await page.waitForTimeout(400); // conversation autosave
      await page.reload();
      await page.getByRole("tab", { name: /Assistant/ }).first().click();
      await answer.locator("h3").nth(2).waitFor({ timeout: 10_000 });
      await check();
      expect(logs.filter((l) => !/favicon/i.test(l))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});

suite("automotive assistant on desktop", () => {
  it("shows a collapsible history sidebar beside the conversation without overflow", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    try {
      await ctx.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: fs.readFileSync(path.join(NEXT, "server/app/index.html"), "utf8") });
        if (url.pathname.startsWith("/_next/static/")) {
          const file = path.join(NEXT, "static", decodeURIComponent(url.pathname.slice("/_next/static/".length)));
          if (!file.startsWith(path.join(NEXT, "static")) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
          return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
        }
        return route.fulfill({ status: 404, body: "" });
      });
      const page = await ctx.newPage();
      const logs: string[] = [];
      page.on("pageerror", (e) => logs.push(e.message));
      await page.goto(`${ORIGIN}/`);
      await mockAssistant(page);
      await page.getByRole("tab", { name: /AI Build Assistant/ }).click();
      await send(page, "How does a turbocharger work?");
      await page.getByText(/exhaust energy to spin a compressor/).waitFor();
      const sidebar = page.getByRole("complementary", { name: "Chat history" });
      await sidebar.getByTestId("chat-item").first().waitFor();
      expect(await sidebar.isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.waitForTimeout(300);
      await shot(page, "desktop-chat");
      await page.getByRole("button", { name: "Hide chat history" }).click();
      await sidebar.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Show chat history" }).click();
      await page.getByRole("complementary", { name: "Chat history" }).waitFor();
      expect(logs).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});

suite("loader motion", () => {
  it("ring rotates normally and stays still with reduced motion", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    for (const pref of ["no-preference", "reduce"] as const) {
      const { page, ctx } = await newPage(390, { reducedMotion: pref });
      try {
        await page.route(/\/api\/vehicles\/models/, () => new Promise(() => {})); // keep the request pending
        await pick(page, "sel-year", (_t, v) => v === "2015");
        await pick(page, "sel-make", (_t, v) => v === "BMW");
        const stage = page.locator('[data-stage="loading"]');
        await stage.waitFor();
        expect(await stage.getAttribute("data-reduced-motion")).toBe(pref === "reduce" ? "true" : "false");
        expect(await stage.locator(".animate-ring").count()).toBe(pref === "reduce" ? 0 : 1);
        await page.locator('[data-brand="BMW"]').waitFor();
        if (SHOTS && pref === "no-preference") {
          await page.waitForTimeout(700);
          await stage.screenshot({ path: path.join(SHOTS, "loader.png") });
        }
      } finally {
        await ctx.close();
      }
    }
  }, 60_000);
});

suite.each([360, 390])("AI power proposal at %ipx", (width) => {
  it("C300 +60 hp: estimated torque in review, Apply enabled, real results — no overflow or console errors", async () => {
    if (!browser) throw new Error("No Edge/Chrome installation found.");
    const { page, ctx, logs } = await newPage(width);
    try {
      // The real assistant pipeline with Gemini mocked: structured output for the +60 hp request.
      const output: ModelOutput = {
        intent: "modify",
        reply: "The modified scenario raises peak power by 60 hp; AutoDyn derives the matching curve.",
        vehicle: { mentioned: true, year: 2015, make: "Mercedes-Benz", model: "C300", trim: "4MATIC" },
        useCurrentVehicle: false,
        changes: [{ scenario: "modified", field: "power", operation: "change", value: 60, unit: "hp", option: "", reason: "60 additional horsepower" }],
        view: "compare",
        runSimulation: true,
        followUpQuestion: null,
      };
      const status = { configured: true, model: "gemini-3.5-flash-lite", deployment: { environment: "preview", branch: "autodyn-v2", commit: "abc1234" }, provider: { status: "ok", model: "gemini-3.5-flash-lite", checkedAt: new Date().toISOString(), latencyMs: 5, source: "access" } };
      await page.route(/\/api\/assistant(\/health)?(\?.*)?$/, async (route) => {
        const req = route.request();
        if (req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(status) });
        const r = await handleAssistantRequest(JSON.parse(req.postData() ?? "{}"), {
          configured: true,
          timeoutMs: 2000,
          callModel: async () => ({ ok: true as const, text: JSON.stringify(output) }),
          limiter: new MemoryRateLimiter({ perMinute: 100, perDay: 100, globalPerDay: 100 }),
          clientKey: "e2e",
          trims: allDatasetTrims,
          nhtsaModels: async () => [],
        });
        return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
      });
      await page.getByRole("tab", { name: /Assistant/ }).click();
      await send(page, "Analyze a stock 2015 Mercedes-Benz C300 4MATIC with the 2.0L turbo engine. Propose a modified version with 60 additional horsepower. Explain what will change and whether the simulation has actually run yet.");
      const panel = page.getByRole("region", { name: "Review changes" }).first();
      await panel.getByText("Estimated peak torque").waitFor({ timeout: 10_000 });
      const text = (await panel.textContent()) ?? "";
      expect(text).toMatch(/241 hp → 301 hp/);
      expect(text).toMatch(/273 lb·ft → 341 lb·ft/);
      expect(text).toMatch(/Valid configuration/);
      expect(text).toMatch(/Proposal pending · not applied · not simulated/);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await panel.scrollIntoViewIfNeeded();
      await shot(page, `${width}-power-proposal`);
      const apply = panel.getByRole("button", { name: /Apply to Simulation/ });
      expect(await apply.isEnabled()).toBe(true);
      await apply.click();
      await page.getByText(/Physics engine results for 2015 Mercedes-Benz C300/).first().waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: /View results/ }).first().click();
      const table = page.getByRole("table", { name: "Computed performance metrics" });
      await table.waitFor({ timeout: 15_000 });
      expect(await table.getByRole("row", { name: /Peak torque/ }).textContent()).toMatch(/273[\s\S]*341/);
      await page.getByTestId("feasibility-modified").waitFor();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, `${width}-power-results`, true);
      expect(logs.filter((l) => !/favicon/i.test(l))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});
