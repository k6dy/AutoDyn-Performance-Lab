import { describe, expect, it, vi } from "vitest";
import { applyProposal } from "@/lib/ai/apply";
import { isPureAppQuestion } from "@/lib/ai/appState";
import { buildAssistantContext, pendingProposalOf } from "@/lib/ai/context";
import { handleAssistantRequest, type AssistantDeps } from "@/lib/ai/handler";
import { historyFor } from "@/lib/ai/history";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import { classifyRelevance } from "@/lib/ai/relevance";
import type { ModelOutput } from "@/lib/ai/schema";
import type { AssistantResponse } from "@/lib/ai/types";
import { effectiveValues } from "@/lib/domain/scenario";
import { runAnalysis } from "@/lib/physics/analysis";
import { kwToHp } from "@/lib/units";
import { allDatasetTrims } from "@/lib/vehicles/dataset.server";
import { config } from "./support/fixtures";

const FULL =
  "Analyze a stock 2015 Mercedes-Benz C300 4MATIC with the 2.0L turbo engine. Propose a modified version with 60 additional horsepower. Explain what will change and whether the simulation has actually run yet.";

/** What Gemini returns for the full request: the vehicle to load, the +60 hp change and an explanation. */
const proposalOutput = (reply: string, vehicle: ModelOutput["vehicle"] = { mentioned: true, year: 2015, make: "Mercedes-Benz", model: "C300", trim: "4MATIC" }): ModelOutput => ({
  intent: "modify",
  reply,
  vehicle,
  useCurrentVehicle: false,
  changes: [{ scenario: "modified", field: "power", operation: "change", value: 60, unit: "hp", option: "", reason: "60 additional horsepower" }],
  view: "compare",
  runSimulation: true,
  followUpQuestion: null,
});
const general = (reply: string): ModelOutput => ({ intent: "general", reply, vehicle: { mentioned: false, year: null, make: null, model: null, trim: null }, useCurrentVehicle: false, changes: [], view: "none", runSimulation: false, followUpQuestion: null });
type Contents = { role: string; parts: { text: string }[] }[];

let n = 0;
async function send(message: string, out: ModelOutput, context = buildAssistantContext({ ...config(), stock: null }, null, "imperial"), history: { role: "user" | "assistant"; text: string }[] = []) {
  const model = vi.fn<AssistantDeps["callModel"]>(async () => ({ ok: true as const, text: JSON.stringify(out) }));
  n += 1;
  const r = await handleAssistantRequest(
    { requestId: `mp${String(n).padStart(10, "0")}`, message, history, context },
    { configured: true, timeoutMs: 500, callModel: model, limiter: new MemoryRateLimiter({ perMinute: 100, perDay: 100, globalPerDay: 100 }), clientKey: "mp", trims: allDatasetTrims, nhtsaModels: async () => [] },
  );
  const body = r.body as Extract<AssistantResponse, { ok: true }>;
  const turn = model.mock.calls.length ? (model.mock.calls[0][0] as Contents).at(-1)!.parts[0].text : "";
  return { r, body, model, turn };
}

describe("the reported multipart C300 request", () => {
  it("1–2, 4. no vehicle selected: Gemini proposes the dataset vehicle and the +60 hp change; the status part is answered by AutoDyn", async () => {
    const { body, model, turn } = await send(FULL, proposalOutput("Loading the 2015 C300 4MATIC as the stock baseline; the modified scenario adds 60 hp. Expect better acceleration once simulated, mainly above traction-limited speeds."));
    expect(model).toHaveBeenCalledOnce(); // not swallowed by the local state handler
    expect(body.local).toBeUndefined();
    expect(body.reply).not.toMatch(/Not answered/); // "Explain what will change" is automotive in context
    expect(body.proposal?.vehicle?.kind).toBe("load");
    if (body.proposal?.vehicle?.kind === "load") {
      expect(body.proposal.vehicle.label).toMatch(/2015 Mercedes-Benz C300.*4MATIC/i);
      expect(kwToHp(body.proposal.vehicle.specSet.values.peakPowerKw.value!)).toBeCloseTo(241, 0); // dataset value, not invented
    }
    expect(body.proposal?.changes[0]).toMatchObject({ target: "modified", display: "+60 hp", statedByUser: true });
    // +60 hp alone fails AutoDyn's deterministic power/torque check, so the next step says so (Apply stays blocked).
    expect(body.reply).toMatch(/\*\*Simulation status:\*\* No — nothing has been simulated yet\. AutoDyn's input validation blocks these values — .*torque.*Adjust them in the proposal below/);
    // Every intent reaches Gemini as a separate part, with AutoDyn's authoritative status.
    expect(turn).toMatch(/1\. Analyze a stock 2015 Mercedes-Benz C300 4MATIC[\s\S]*2\. Propose a modified version with 60 additional horsepower\.[\s\S]*3\. Explain what will change[\s\S]*4\. Whether the simulation has actually run yet/);
    expect(turn).toMatch(/APP STATE \(authoritative[^)]*\): No — nothing has been simulated yet\./);
  });

  it("the relevance gate keeps every part (nothing declined) and the message is not a pure state question", () => {
    const r = classifyRelevance(FULL, { history: [], hasVehicle: false, hasResults: false });
    expect(r.decision).toBe("allow");
    expect(r.declined).toBeUndefined();
    expect(isPureAppQuestion(FULL)).toBe(false);
  });

  it("3. a status question on its own is still answered locally and accurately (zero Gemini calls)", async () => {
    const { body, model } = await send("Have you actually run the simulation yet?", general("x"));
    expect(model).not.toHaveBeenCalled();
    expect(body).toMatchObject({ local: "app_state" });
    expect(body.reply).toMatch(/^No — nothing has been simulated yet\./);
    for (const q of ["Have you run it yet?", "What do I click next?", "Is the proposal applied?"]) expect(isPureAppQuestion(q), q).toBe(true);
  });

  it("5. pending proposal: calculated results the engine hasn't produced are removed", async () => {
    const { body } = await send(FULL, proposalOutput("The +60 hp version will run 0-60 in 5.1 s, 0.7 s quicker. The simulation shows a clear gain. Power rises from the stock baseline."));
    expect(body.reply).not.toMatch(/5\.1 s|0\.7 s|simulation shows/);
    expect(body.reply).toMatch(/Power rises from the stock baseline\./);
  });

  it("6–8. approval applies stock and modified independently; Run Analysis gives real deterministic results", async () => {
    const valid = "Analyze a stock 2015 Mercedes-Benz C300 4MATIC. Propose a modified version with 60 additional horsepower and 60 lb-ft more torque, and say whether the simulation has run yet.";
    const out = proposalOutput("Ready for review.");
    out.changes.push({ scenario: "modified", field: "torque", operation: "change", value: 60, unit: "lbft", option: "", reason: "60 lb-ft more torque" });
    const { body } = await send(valid, out);
    const proposal = body.proposal!;
    expect(body.reply).toMatch(/\*\*Simulation status:\*\* No — nothing has been simulated yet\. review the proposed changes below and select Apply to Simulation/);
    const empty = { ...config(), stock: null };
    // Nothing changes until the user approves.
    expect(empty.stock).toBeNull();
    const { config: applied } = applyProposal(empty, proposal, { selected: Object.fromEntries(proposal.changes.map((c) => [c.id, true])) });
    const stock = effectiveValues(applied, "stock")!;
    const modified = effectiveValues(applied, "modified")!;
    expect(kwToHp(stock.peakPowerKw.value as number)).toBeCloseTo(241, 0);
    expect(kwToHp(modified.peakPowerKw.value as number)).toBeCloseTo(301, 0);
    expect(stock.curbMassKg.value).toBe(modified.curbMassKg.value); // only power and torque differ
    const result = runAnalysis(applied);
    expect(result.modified).not.toBeNull();
    expect(result.modified!.metrics.zeroTo60S!).toBeLessThan(result.stock.metrics.zeroTo60S!);
    expect(runAnalysis(applied).modified!.metrics.zeroTo60S).toBe(result.modified!.metrics.zeroTo60S); // deterministic
    // While it's still pending, the context says so and nothing is simulated.
    const pending = pendingProposalOf([{ proposal, status: "pending", selected: {}, chosen: null }]);
    expect(pending?.changes).toEqual(["Peak power +60 hp", "Peak torque +60 lb·ft"]);
  });

  it("9. a vehicle AutoDyn has no data for gets a manual-entry fallback, never invented specs", async () => {
    const { body } = await send(
      "Analyze a stock 1987 Yugo GV. Propose a version with 60 additional horsepower and say whether the simulation has run yet.",
      proposalOutput("I'll need the Yugo's specifications first.", { mentioned: true, year: 1987, make: "Yugo", model: "GV", trim: null }),
    );
    expect(["not_found", "identify"]).toContain(body.proposal?.vehicle?.kind);
    expect(body.proposal?.changes).toEqual([]);
    expect(body.proposal?.rejected[0].reason).toMatch(/Choose a vehicle before proposing changes/);
    expect(body.reply).toMatch(/\*\*Simulation status:\*\* No — nothing has been simulated yet\. AutoDyn needs the missing specifications/);
  });

  it("10. a clearly unrelated request makes zero Gemini calls", async () => {
    const { body, model } = await send("What's the capital of France and who wrote Hamlet?", general("x"));
    expect(model).not.toHaveBeenCalled();
    expect(body.local).toBe("off_topic");
  });

  it("11. mixed request: the vehicle proposal is kept and only the unrelated part is declined", async () => {
    const { body, turn } = await send(
      "Analyze a stock 2015 Mercedes-Benz C300 4MATIC. Propose a modified version with 60 additional horsepower. Also write me a poem about flowers.",
      proposalOutput("Prepared for review."),
    );
    expect(body.proposal?.vehicle?.kind).toBe("load");
    expect(body.proposal?.changes[0].display).toBe("+60 hp");
    expect(turn).not.toMatch(/poem/);
    expect(body.reply).toMatch(/Not answered: “Write me a poem about flowers”/);
  });

  it("separate turns behave like the bundled message", async () => {
    const t: { role: "user" | "assistant"; text: string }[] = [];
    const a = await send("Analyze a stock 2015 Mercedes-Benz C300 4MATIC and propose a version with 60 additional horsepower.", proposalOutput("Prepared for review."));
    expect(a.body.proposal?.vehicle?.kind).toBe("load");
    t.push({ role: "user", text: "Analyze a stock 2015 Mercedes-Benz C300 4MATIC and propose a version with 60 additional horsepower." }, { role: "assistant", text: a.body.reply });
    const b = await send("Explain what will change.", general("Only peak power changes; weight and gearing stay the same."), undefined, historyFor(t));
    expect(b.model).toHaveBeenCalledOnce();
    expect(b.body.local).toBeUndefined();
    const pending = pendingProposalOf([{ proposal: a.body.proposal!, status: "pending", selected: {}, chosen: null }]);
    const c = await send("Has the simulation actually run yet?", general("x"), buildAssistantContext({ ...config(), stock: null }, null, "imperial", pending), historyFor(t));
    expect(c.model).not.toHaveBeenCalled();
    expect(c.body.reply).toMatch(/^No — nothing has been simulated yet\. The proposal \(2015 Mercedes-Benz C300.*Peak power \+60 hp\) is waiting for your approval/);
  });

  it("duplicate submissions of one request produce one answer", async () => {
    const model = vi.fn<AssistantDeps["callModel"]>(async () => ({ ok: true as const, text: JSON.stringify(general("Answer.")) }));
    const deps: AssistantDeps = { configured: true, timeoutMs: 500, callModel: model, limiter: new MemoryRateLimiter({ perMinute: 100, perDay: 100, globalPerDay: 100 }), clientKey: "dup", trims: allDatasetTrims, nhtsaModels: async () => [] };
    const req = { requestId: "dupcheck00001", message: "How does a turbocharger work?", history: [], context: buildAssistantContext(config(), null, "imperial") };
    const [first, second] = await Promise.all([handleAssistantRequest(req, deps), handleAssistantRequest(req, deps)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(model).toHaveBeenCalledOnce();
  });
});
