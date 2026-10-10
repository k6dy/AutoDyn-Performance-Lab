import { beforeEach, describe, expect, it, vi } from "vitest";
import { appStateReply, isAppQuestion } from "@/lib/ai/appState";
import { buildAssistantContext, type PendingProposal } from "@/lib/ai/context";
import { stripFalseAttribution, stripUnmodeledClaims } from "@/lib/ai/guards";
import { handleAssistantRequest, type AssistantDeps } from "@/lib/ai/handler";
import { historyFor } from "@/lib/ai/history";
import { SYSTEM_INSTRUCTION } from "@/lib/ai/prompt";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import { classifyRelevance } from "@/lib/ai/relevance";
import type { ModelOutput } from "@/lib/ai/schema";
import { deriveTopic, pinnedVehicles } from "@/lib/ai/topic";
import type { AssistantResponse } from "@/lib/ai/types";
import { parseConversation, withDerived, type StoredMessage } from "@/lib/persistence/conversations";
import { runAnalysis } from "@/lib/physics/analysis";
import { clearOwnershipCache, lookupFuelEconomy, type FuelEconomyResult, type JsonFetcher } from "@/lib/vehicles/ownershipData.server";
import { allDatasetTrims } from "@/lib/vehicles/dataset.server";
import { config } from "./support/fixtures";
import { userValue } from "@/lib/domain/scenario";
import type { AnalysisConfig } from "@/lib/domain/types";

const modified = (hp: number): AnalysisConfig => ({ ...config(), modified: { overrides: { peakPowerKw: userValue(hpToKw(hp)) } } });
import { hpToKw } from "@/lib/units";

const out = (reply: string, patch: Partial<ModelOutput> = {}): ModelOutput => ({
  intent: "general",
  reply,
  vehicle: { mentioned: false, year: null, make: null, model: null, trim: null },
  useCurrentVehicle: false,
  changes: [],
  view: "none",
  runSimulation: false,
  followUpQuestion: null,
  ...patch,
});
type Contents = { role: string; parts: { text: string }[] }[];
type Msg = { role: "user" | "assistant"; text: string; kind?: "local"; localKind?: string };

const PENDING: PendingProposal = { vehicle: null, needsChoice: false, changes: ["Peak power +50 hp"] };
const noResults = (pending: PendingProposal | null = null) => buildAssistantContext(config(), null, "imperial", pending);
const withResults = (opts: { stale?: boolean; pending?: PendingProposal | null; snapshot?: { savedAt: string; engineCurrent: boolean } | null } = {}) =>
  buildAssistantContext(config(), { analysis: runAnalysis(config()), stale: !!opts.stale }, "imperial", opts.pending ?? null, opts.snapshot ?? null);

let n = 0;
function harness() {
  const transcript: Msg[] = [];
  const model = vi.fn<AssistantDeps["callModel"]>(async () => ({ ok: true as const, text: JSON.stringify(out("Answer.")) }));
  const fuelEconomy = vi.fn(async (): Promise<FuelEconomyResult> => ({ status: "needs_year", source: "U.S. EPA fueleconomy.gov", query: "x", note: "x" }));
  const deps: AssistantDeps = {
    configured: true,
    timeoutMs: 500,
    callModel: model,
    limiter: new MemoryRateLimiter({ perMinute: 1000, perDay: 10000, globalPerDay: 10000 }),
    clientKey: "app",
    trims: allDatasetTrims,
    nhtsaModels: async () => [],
    ownership: { fuelEconomy, recalls: vi.fn(), variants: vi.fn() },
  };
  async function say(text: string, context = noResults(), reply: ModelOutput | string = "Answer.") {
    model.mockImplementationOnce(async () => ({ ok: true as const, text: JSON.stringify(typeof reply === "string" ? out(reply) : reply) }));
    const before = model.mock.calls.length;
    n += 1;
    const r = await handleAssistantRequest({ requestId: `app${String(n).padStart(9, "0")}`, message: text, history: historyFor(transcript as never), context }, deps);
    const body = r.body as Extract<AssistantResponse, { ok: true }>;
    const called = model.mock.calls.length > before;
    const turn = called ? (model.mock.calls.at(-1)![0] as Contents).at(-1)!.parts[0].text : "";
    if (body.local) transcript.push({ role: "user", text, kind: "local", localKind: body.local }, { role: "assistant", text: body.reply, kind: "local", localKind: body.local });
    else transcript.push({ role: "user", text }, { role: "assistant", text: body.reply });
    return { body, called, turn };
  }
  return { say, model, fuelEconomy };
}

beforeEach(() => clearOwnershipCache());

describe("questions about AutoDyn itself", () => {
  it("are in scope — the reported bug and the full list — even in a new chat", () => {
    const none = { history: [], hasVehicle: false, hasResults: false };
    for (const q of [
      "Have you actually run the simulation yet?",
      "Have you run it yet?",
      "Is the proposal applied?",
      "What are my current specifications?",
      "What changes are pending?",
      "What do I click next?",
      "Are my results up to date?",
      "What is the feasibility assessment?",
      "Why is the graph flat?",
      "How do I save this analysis?",
      "How do I reset everything?",
    ]) {
      expect(isAppQuestion(q), q).toBe(true);
      expect(classifyRelevance(q, none).decision, q).toBe("allow");
    }
    expect(classifyRelevance("Do cows hibernate?", none).decision).toBe("reject");
    expect(classifyRelevance("Write a poem about my results", none).decision).toBe("reject"); // an off-topic task is still off-topic
  });

  it("simulation pending → 'Have you run it yet?' says no, locally, with the exact next step", async () => {
    const h = harness();
    const r = await h.say("Have you actually run the simulation yet?", noResults(PENDING));
    expect(r.called).toBe(false);
    expect(r.body.local).toBe("app_state");
    expect(r.body.reply).toMatch(/^No — nothing has been simulated yet\. The proposal \(Peak power \+50 hp\) is waiting for your approval/);
    expect(r.body.reply).toMatch(/Apply to Simulation/);
  });

  it("simulation complete → 'Have you run it yet?' says yes with the engine's own numbers", async () => {
    const h = harness();
    const ctx = withResults();
    const row = ctx.results!.metrics.find((m) => /0–60/.test(m.metric))!;
    const r = await h.say("Have you run it yet?", ctx);
    expect(r.called).toBe(false);
    expect(r.body.reply).toMatch(/^Yes — simulation complete: AutoDyn has calculated \(simulated\) results for the current configuration.*they are current/);
    expect(r.body.reply).toContain(row.stock);
    const stale = await h.say("Have you run the simulation?", withResults({ stale: true }));
    expect(stale.body.reply).toMatch(/^Not for the current inputs/);
    const both = await h.say("Did the analysis run?", withResults({ pending: PENDING }));
    expect(both.body.reply).toMatch(/Yes for the applied configuration.*but the pending proposal \(Peak power \+50 hp\) hasn't been applied or simulated/);
  });

  it("proposal awaiting approval → 'What do I click next?'", async () => {
    const h = harness();
    expect((await h.say("What do I click next?", noResults(PENDING))).body.reply).toMatch(/select \*\*Apply to Simulation\*\*/);
    expect((await h.say("What do I click next?", noResults({ ...PENDING, needsChoice: true }))).body.reply).toMatch(/^Choose the exact variant/);
    expect((await h.say("What do I click next?", noResults())).body.reply).toMatch(/Run analysis/);
    expect((await h.say("What do I click next?", buildAssistantContext({ ...config(), stock: null }, null, "imperial"))).body.reply).toMatch(/Choose a vehicle in \*\*Manual Setup\*\*/);
  });

  it("saved results → 'Are these results current?' reports the snapshot honestly", async () => {
    const h = harness();
    const saved = await h.say("Are these results current?", withResults({ snapshot: { savedAt: "2026-10-01T09:00:00.000Z", engineCurrent: true } }));
    expect(saved.body.reply).toMatch(/^These are saved results from 2026-10-01, shown as stored\. They match the inputs they were saved with and the current engine version\./);
    const old = await h.say("Are my results up to date?", withResults({ snapshot: { savedAt: "2026-01-01T09:00:00.000Z", engineCurrent: false } }));
    expect(old.body.reply).toMatch(/earlier engine version — select \*\*Recalculate using current engine\*\*/);
    expect((await h.say("Are my results up to date?", withResults({ stale: true }))).body.reply).toMatch(/^No — inputs changed/);
    expect((await h.say("Are my results up to date?", noResults())).body.reply).toMatch(/^There are no results yet/);
  });

  it("proposed, applied and completed are reported as separate states", () => {
    const ctx = buildAssistantContext(modified(281), null, "imperial", PENDING);
    expect(appStateReply("Is the proposal applied?", ctx)).toMatch(/^No — the proposal is still pending: Peak power \+50 hp\./);
    expect(appStateReply("What changes are pending?", ctx)).toMatch(/^Pending \(proposed, not applied or simulated\): Peak power \+50 hp\. Applied: Peak power .* → 281 hp/);
    expect(appStateReply("What is the feasibility assessment?", ctx)).toMatch(/^There's no feasibility assessment yet/);
    expect(appStateReply("What are my current specifications?", noResults())).toMatch(/Peak power: 241 hp \(verified dataset\)/);
    expect(appStateReply("How do I save this analysis?", noResults())).toMatch(/saved automatically to \*\*Saved Analyses\*\*.*Nothing has been run yet/);
    expect(appStateReply("How do I reset everything?", noResults())).toMatch(/\*\*New Analysis\*\*/);
    expect(appStateReply("Why is the graph flat?", noResults())).toBeNull(); // needs an explanation → Gemini, with context
  });

  it("explanations about the app still reach Gemini with the authoritative state", async () => {
    const h = harness();
    const r = await h.say("Why is the graph flat?", withResults());
    expect(r.called).toBe(true);
    expect(r.turn).toMatch(/"results":\{"stale":false/);
  });
});

describe("source accuracy", () => {
  it("horsepower credited to EPA or 'verified' must be in AutoDyn's data; dataset values are kept", async () => {
    const h = harness();
    const bad = await h.say("How much power does the 2018 F-Type R make?", noResults(), "EPA data confirms the F-Type R makes 550 hp. It uses a supercharged 5.0 L V8.");
    expect(bad.body.reply).toBe("It uses a supercharged 5.0 L V8.");
    expect(bad.body.notices.join(" ")).toMatch(/EPA data covers fuel economy, not horsepower or torque/);
    const ok = await h.say("What power does my car have?", noResults(), "AutoDyn's verified dataset lists 241 hp for your C300.");
    expect(ok.body.reply).toBe("AutoDyn's verified dataset lists 241 hp for your C300.");
    expect(stripFalseAttribution("Commonly quoted as about 550 hp (general knowledge).", "").removed).toBe(0); // not claimed as verified
    expect(SYSTEM_INSTRUCTION).toMatch(/EPA never verifies horsepower, torque or other mechanical specifications/);
    expect(SYSTEM_INSTRUCTION).toMatch(/AutoDyn has no verified manufacturer-specification source/);
  });

  it("coverage limits are reported as such, never as non-existence", async () => {
    const fetcher: JsonFetcher = async (url) => (url.includes("menu/make") ? { menuItem: [{ text: "BMW", value: "BMW" }] } : { menuItem: [{ text: "X5", value: "X5" }] });
    const r = await lookupFuelEconomy({ year: 2018, make: "BMW", model: "M4" }, { fetcher });
    expect(r).toMatchObject({ status: "not_found" });
    if (r.status !== "found") expect(r.note).toMatch(/coverage limitation — the name may differ; not evidence the vehicle doesn't exist/);
    expect(SYSTEM_INSTRUCTION).toMatch(/say it isn't in that dataset or list — never that it doesn't exist/);
  });
});

describe("EPA vehicle matching", () => {
  const routes =
    (map: Record<string, unknown>): JsonFetcher =>
    async (url) => {
      const key = Object.keys(map).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected ${url}`);
      return map[key];
    };
  const rec = (id: string, model: string, comb: string, drive = "Rear-Wheel Drive") => ({ id, year: "2018", make: "x", model, city08: "17", highway08: "24", comb08: comb, fuelType: "Premium", drive, trany: "x", atvType: "" });

  it("Jaguar F-Type R: coupe and convertible are labeled separately; 'coupe' selects only the coupe", async () => {
    const jag = routes({
      "menu/make?year=2018": { menuItem: [{ text: "Jaguar", value: "Jaguar" }] },
      "menu/model?year=2018&make=Jaguar": { menuItem: ["F-Type R AWD Convertible", "F-Type R AWD Coupe", "F-Type S Coupe"].map((t) => ({ text: t, value: t })) },
      "model=F-Type%20R%20AWD%20Convertible": { menuItem: { text: "Auto (S8), 8 cyl, 5.0 L, Sup Charg", value: "11" } },
      "model=F-Type%20R%20AWD%20Coupe": { menuItem: { text: "Auto (S8), 8 cyl, 5.0 L, Sup Charg", value: "12" } },
      "vehicle/11": rec("11", "F-Type R AWD Convertible", "18", "All-Wheel Drive"),
      "vehicle/12": rec("12", "F-Type R AWD Coupe", "18", "All-Wheel Drive"),
    });
    const both = await lookupFuelEconomy({ year: 2018, make: "Jaguar", model: "F-Type R" }, { fetcher: jag });
    if (both.status !== "found") throw new Error(both.status);
    expect(both.variants.map((v) => v.label.split(" — ")[0])).toEqual(["2018 Jaguar F-Type R AWD Convertible", "2018 Jaguar F-Type R AWD Coupe"]);
    expect(both).toMatchObject({ variantsDifferIn: ["body: convertible / coupe"], sameRatingForAll: true });
    clearOwnershipCache();
    const coupe = await lookupFuelEconomy({ year: 2018, make: "Jaguar", model: "F-Type R", prefer: ["coupe"] }, { fetcher: jag });
    if (coupe.status !== "found") throw new Error(coupe.status);
    expect(coupe.variants.map((v) => v.label)).toEqual(["2018 Jaguar F-Type R AWD Coupe — Auto (S8), 8 cyl, 5.0 L, Sup Charg"]);
  });

  const bmw = () =>
    routes({
      "menu/make?year=2018": { menuItem: [{ text: "BMW", value: "BMW" }] },
      "menu/model?year=2018&make=BMW": { menuItem: ["M3", "M4 Convertible", "M4 Coupe", "M4 GTS"].map((t) => ({ text: t, value: t })) },
      "model=M4%20Coupe": { menuItem: [{ text: "Man 6-spd, 6 cyl, 3.0 L, Turbo", value: "21" }, { text: "Auto (AM-S7), 6 cyl, 3.0 L, Turbo", value: "22" }] },
      "model=M4%20Convertible": { menuItem: { text: "Auto (AM-S7), 6 cyl, 3.0 L, Turbo", value: "23" } },
      "model=M4%20GTS": { menuItem: { text: "Auto (AM-S7), 6 cyl, 3.0 L, Turbo", value: "24" } },
      "vehicle/21": rec("21", "M4 Coupe", "20"),
      "vehicle/22": rec("22", "M4 Coupe", "21"),
      "vehicle/23": rec("23", "M4 Convertible", "20"),
      "vehicle/24": rec("24", "M4 GTS", "19"),
    });

  it("2018 BMW M4: differences are listed; 'manual coupe' narrows to that exact variant", async () => {
    const all = await lookupFuelEconomy({ year: 2018, make: "BMW", model: "M4" }, { fetcher: bmw() });
    if (all.status !== "found") throw new Error(all.status);
    expect(all.variantsDifferIn).toEqual(expect.arrayContaining([expect.stringMatching(/^body: /), expect.stringMatching(/^transmission: /)]));
    expect(all.sameRatingForAll).toBe(false);
    clearOwnershipCache();
    const exact = await lookupFuelEconomy({ year: 2018, make: "BMW", model: "M4", prefer: ["coupe", "manual"] }, { fetcher: bmw() });
    if (exact.status !== "found") throw new Error(exact.status);
    expect(exact.variants.map((v) => v.label)).toEqual(["2018 BMW M4 Coupe — Man 6-spd, 6 cyl, 3.0 L, Turbo"]);
    expect(exact.variants[0].combinedMpg).toBe(20);
  });

  it("'2018 BMW M4' and '2018 M4' keep the model year (and infer BMW) — no needless 'which year?'", async () => {
    for (const q of ["What's the MPG of the 2018 BMW M4?", "What's the MPG of a 2018 M4?"]) {
      expect(pinnedVehicles(deriveTopic([{ role: "user", text: q }]).topic), q).toEqual([{ year: 2018, make: "BMW", model: "M4" }]);
    }
    const h = harness();
    await h.say("What's the MPG of a 2018 M4 coupe with the manual?");
    expect(h.fuelEconomy).toHaveBeenCalledWith(expect.objectContaining({ year: 2018, make: "BMW", model: "M4", prefer: expect.arrayContaining(["coupe", "manual"]) }), expect.anything());
  });
});

describe("engineering claims match what the feasibility engine implements", () => {
  it("claims that AutoDyn models cooling, thermal stress or tolerances are removed; honest limits are kept", async () => {
    const h = harness();
    const r = await h.say(
      "Is +150 hp feasible on my C300?",
      withResults(),
      "AutoDyn's feasibility assessment accounts for cooling capacity and stock component tolerances. Traction is the main limit at launch. AutoDyn doesn't model cooling, so check the radiator separately.",
    );
    expect(r.body.reply).toBe("Traction is the main limit at launch. AutoDyn doesn't model cooling, so check the radiator separately.");
    expect(r.body.notices.join(" ")).toMatch(/doesn't model cooling, thermal stress or stock component tolerances/);
    expect(stripUnmodeledClaims("The simulation evaluates thermal stress on the pistons.").removed).toBe(1);
  });

  it("the prompt's feasibility scope covers every check the engine produces — and nothing thermal", () => {
    const analysis = runAnalysis(modified(400));
    const ids = new Set([analysis.feasibility.stock, analysis.feasibility.modified].flatMap((a) => a?.checks.map((c) => c.id) ?? []));
    const scope = SYSTEM_INSTRUCTION.split("Feasibility scope:")[1].split("\n")[0];
    const phrase: Record<string, RegExp> = {
      data: /input data sources/,
      powertrain: /power\/torque consistency, specific output/,
      mass: /weight change/,
      traction: /launch traction and tire grip/,
      aero: /drag area and the model's speed range/,
      acceleration: /acceleration envelope and stated performance claims/,
      model: /power-to-weight/,
      mechanical: /component capacity only against component ratings the user entered/,
    };
    expect(ids.size).toBeGreaterThan(3);
    for (const id of ids) expect(scope, id).toMatch(phrase[id.split(".")[0]]);
    expect(scope).toMatch(/does not model cooling, thermal stress, heat soak, stock component tolerances/);
  });
});

describe("sequential and multipart messages", () => {
  it("separate turns: automotive → off-topic → app status → follow-up keeps the subject; only Gemini where needed", async () => {
    const h = harness();
    expect((await h.say("How does a turbocharger work?")).called).toBe(true);
    expect(await h.say("Do cows hibernate?")).toMatchObject({ called: false, body: { local: "off_topic" } });
    expect(await h.say("Have you run the simulation yet?")).toMatchObject({ called: false, body: { local: "app_state" } });
    const rel = await h.say("What about reliability?");
    expect(rel.called).toBe(true);
    expect(rel.turn).toMatch(/SUBJECT .*turbochargers/);
    expect(rel.turn).not.toMatch(/cows|simulation yet/);
  });

  it("multipart: an app-status question plus an unrelated one is answered locally and the rest declined", async () => {
    const h = harness();
    const r = await h.say("Have you run the simulation yet, and what's the capital of France?", noResults(PENDING));
    expect(r.called).toBe(false);
    expect(r.body.reply).toMatch(/^No — nothing has been simulated yet\.[\s\S]*\n\nNot answered: “What's the capital of France”/);
    expect(await h.say("What's the capital of France and who wrote Hamlet?")).toMatchObject({ called: false, body: { local: "off_topic" } });
  });

  it("saved conversations with app-state answers restore and stay out of Gemini's context", () => {
    const messages: StoredMessage[] = [
      { id: "u1", role: "user", text: "Tell me about the 2018 Jaguar F-Type R.", createdAt: 1 },
      { id: "a1", role: "assistant", text: "It's a supercharged V8 sports car.", createdAt: 2 },
      { id: "u2", role: "user", text: "Have you run the simulation yet?", createdAt: 3, kind: "local", localKind: "app_state" },
      { id: "a2", role: "assistant", text: "No — nothing has been simulated yet.", createdAt: 4, kind: "local", localKind: "app_state" },
    ];
    const c = withDerived({ id: "chat000222", title: "2018 Jaguar F-Type R", customTitle: false, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", vehicleLabel: null, analysisIds: [], messages, vehicle: null });
    const back = parseConversation(c, { id: c.id, messages: c.messages, vehicle: null });
    expect(back?.messages.map((m) => m.localKind ?? null)).toEqual([null, null, "app_state", "app_state"]);
    expect(historyFor(back!.messages).map((m) => m.text)).toEqual(["Tell me about the 2018 Jaguar F-Type R.", "It's a supercharged V8 sports car."]);
  });
});
