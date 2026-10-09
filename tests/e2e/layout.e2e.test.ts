// Real-browser checks against the production build (`npm run build` first).
// A locally installed Chromium-family browser (Edge/Chrome) is driven headlessly; every request is
// fulfilled in-process from `.next/` and the real route handlers — no server or port is started.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as assistantGet, POST as assistantPost } from "@/app/api/assistant/route";
import { GET as healthGet } from "@/app/api/assistant/health/route";
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
