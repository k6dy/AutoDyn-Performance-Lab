import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssistantContext } from "@/lib/ai/context";
import { aiConfig, geminiCaller, resetProviderHealth } from "@/lib/ai/gemini.server";
import { handleAssistantRequest, type AssistantDeps } from "@/lib/ai/handler";
import { compactTurn, historyFor } from "@/lib/ai/history";
import { SYSTEM_INSTRUCTION } from "@/lib/ai/prompt";
import { cleanReply, clipText, completedPart, salvageReply } from "@/lib/ai/proposal";
import { MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import { classifyRelevance } from "@/lib/ai/relevance";
import { describePlan, OUTPUT_BUDGET, planResponse, splitParts } from "@/lib/ai/responsePlan";
import { modelOutputJsonSchema, type ModelOutput } from "@/lib/ai/schema";
import { AI_LIMITS, SHORTENED_NOTICE, type AssistantResponse } from "@/lib/ai/types";
import { allDatasetTrims } from "@/lib/vehicles/dataset.server";
import { config } from "./support/fixtures";

const general = (reply: string, patch: Partial<ModelOutput> = {}): ModelOutput => ({
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

type Turn = { role: "user" | "assistant"; text: string };
type Contents = { role: string; parts: { text: string }[] }[];

let counter = 0;
function request(message: string, history: Turn[] = [], extra: Record<string, unknown> = {}) {
  counter += 1;
  return { requestId: `rq${String(counter).padStart(10, "0")}`, message, history, context: buildAssistantContext(config(), null, "imperial"), ...extra };
}

function deps(callModel: AssistantDeps["callModel"]): AssistantDeps {
  return {
    configured: true,
    timeoutMs: 500,
    callModel,
    limiter: new MemoryRateLimiter({ perMinute: 500, perDay: 5000, globalPerDay: 5000 }),
    clientKey: "quality",
    trims: allDatasetTrims,
    nhtsaModels: async () => [],
  };
}

const model = (out: ModelOutput | string, extra: { truncated?: boolean } = {}) =>
  vi.fn<AssistantDeps["callModel"]>(async () => ({ ok: true as const, text: typeof out === "string" ? out : JSON.stringify(out), ...extra }));

async function ask(message: string, history: Turn[] = [], out: ModelOutput | string = general("ok"), extra: { truncated?: boolean } = {}) {
  const m = model(out, extra);
  const r = await handleAssistantRequest(request(message, history), deps(m));
  const call = m.mock.calls[0] as [Contents, AbortSignal, { maxOutputTokens?: number }] | undefined;
  return { r, body: r.body as Extract<AssistantResponse, { ok: true }>, m, turn: call?.[0].at(-1)!.parts[0].text ?? "", budget: call?.[2]?.maxOutputTokens, contents: call?.[0] };
}

describe("adaptive answer depth", () => {
  it("simple factual questions get a brief answer", () => {
    for (const q of ["What does RPM mean?", "What is RPM?", "What does ECU stand for?", "Is the F-Type AWD?"]) expect(planResponse(q).depth, q).toBe("brief");
  });

  it("standard explanations get readable paragraphs, not a one-liner or an essay", () => {
    for (const q of ["How does a turbocharger work?", "What causes engine knock?", "What's the difference between a wastegate and a blow-off valve?", "What about reliability?", "What models are there?"])
      expect(planResponse(q).depth, q).toBe("standard");
  });

  it("detailed technical questions get a substantive, organized answer", () => {
    expect(planResponse("Explain how turbocharger boost pressure, air temperature, intercooler efficiency and ignition timing affect horsepower.").depth).toBe("detailed");
    expect(planResponse("Compare the BMW M340i and Mercedes-AMG C43.")).toMatchObject({ depth: "detailed", comparison: true });
  });

  it("explicit depth requests override the default in both directions", () => {
    for (const q of ["Explain in detail.", "Go deeper.", "Give me the technical explanation.", "Break down every part.", "Explain the physics."]) expect(planResponse(q).explicit, q).toBe("more");
    expect(planResponse("Briefly, how does a turbo work?")).toMatchObject({ depth: "brief", explicit: "less" });
    expect(planResponse("How does a turbo work?", { detail: true }).depth).toBe("detailed"); // the "Explain in detail" button
  });

  it("beginner and technical audiences are recognised and described to the model", () => {
    const beginner = planResponse("Explain like I'm a beginner how a turbo works");
    expect(beginner).toMatchObject({ audience: "beginner", depth: "standard" });
    expect(describePlan(beginner)).toMatch(/plain language; define each technical term/);
    const technical = planResponse("Give me the technical explanation of boost pressure and charge-air temperature");
    expect(technical).toMatchObject({ audience: "technical", depth: "detailed" });
    expect(describePlan(technical)).toMatch(/governing relationships/);
  });

  it("follow-ups are told to build on earlier answers instead of repeating them", () => {
    expect(describePlan(planResponse("What about reliability?", { followUp: true }))).toMatch(/don't repeat what was already explained/);
    expect(describePlan(planResponse("Go deeper.", { followUp: true }))).toMatch(/more depth on the previous answer/);
  });
});

describe("multiple questions get separate answers", () => {
  it("splits distinct questions in order", () => {
    expect(splitParts("What's a wastegate, what's a blow-off valve, and which one is more important?")).toEqual(["What's a wastegate", "What's a blow-off valve", "Which one is more important?"]);
    expect(splitParts("Explain a wastegate, a blow-off valve and an intercooler.")).toEqual(["A wastegate", "A blow-off valve", "An intercooler"]);
    expect(splitParts("Compare AWD and RWD. Which is better for traction, and what are the disadvantages?")).toEqual(["Compare AWD and RWD.", "Which is better for traction", "What are the disadvantages?"]);
    expect(splitParts("How does a turbo work and is it reliable?")).toEqual(["How does a turbo work", "Is it reliable?"]);
  });

  it("does not split single questions, relationships, fragments or context statements", () => {
    for (const q of [
      "What's the difference between a wastegate and a blow-off valve?",
      "Explain how boost pressure, air temperature, intercooler efficiency and ignition timing affect horsepower.",
      "Is the 5.0 V8 or the 3.0 V6 better, and why?",
      "Briefly, what is turbo lag?",
      "My car shakes at idle and the check engine light is flashing. What could it be?",
      "Which one would you recommend and why?",
    ])
      expect(splitParts(q), q).toEqual([]);
  });

  it("the provider receives every part with an instruction to answer each separately", async () => {
    const { turn, budget } = await ask("Explain a wastegate, a blow-off valve and an intercooler.");
    expect(turn).toMatch(/Answer EVERY part separately and in this order/);
    expect(turn).toMatch(/1\. A wastegate\n {2}2\. A blow-off valve\n {2}3\. An intercooler/);
    expect(budget).toBe(OUTPUT_BUDGET.detailed);
    const awd = await ask("Compare AWD and RWD. Which is better for traction, and what are the disadvantages?");
    expect(awd.turn).toMatch(/1\. Compare AWD and RWD\.\n {2}2\. Which is better for traction\n {2}3\. What are the disadvantages\?/);
    expect(awd.turn).toMatch(/Comparison: brief overview/);
  });

  it("system instruction requires separate answers and no longer forces compressed plain text", () => {
    expect(SYSTEM_INSTRUCTION).toMatch(/answer EVERY part, separately and in order/);
    expect(SYSTEM_INSTRUCTION).not.toMatch(/Plain text only|about 3 short sentences|~60 words\), up to/);
    expect(SYSTEM_INSTRUCTION).toMatch(/Markdown subset/);
    expect(modelOutputJsonSchema.properties.reply.description).not.toMatch(/Concise plain-text/);
  });
});

describe("output budget and formatting preservation", () => {
  it("the token budget follows the answer depth", async () => {
    expect((await ask("What does RPM mean?")).budget).toBe(OUTPUT_BUDGET.brief);
    expect((await ask("How does a turbocharger work?")).budget).toBe(OUTPUT_BUDGET.standard);
    expect((await ask("Explain turbo lag in detail")).budget).toBe(OUTPUT_BUDGET.detailed);
  });

  it("line breaks, lists, headings and tables in a reply reach the client unchanged", async () => {
    const reply = "### Wastegate\nBleeds exhaust around the turbine to cap boost.\n\n### Blow-off valve\n- Vents intake pressure\n- Opens when the throttle closes\n\n| Part | Side |\n|---|---|\n| Wastegate | Exhaust |";
    const { body } = await ask("What's a wastegate and what's a blow-off valve?", [], general(reply));
    expect(body.reply).toBe(reply);
  });

  it("detailed answers are no longer cut at 2,400 characters", async () => {
    const reply = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} explains one relationship between boost, charge temperature and timing in plain words.`.repeat(3)).join("\n\n");
    expect(reply.length).toBeGreaterThan(3000);
    const { body } = await ask("Explain turbo lag in detail", [], general(reply));
    expect(body.reply).toBe(reply);
    expect(body.notices).not.toContain(SHORTENED_NOTICE);
  });

  it("an over-long reply is shortened at a paragraph boundary with a notice instead of being rejected", async () => {
    const para = "Boost raises cylinder air mass; timing and charge temperature decide how much of it becomes torque.";
    const reply = Array.from({ length: 120 }, () => para).join("\n\n");
    const { r, body } = await ask("Explain turbo lag in detail", [], general(reply));
    expect(r.status).toBe(200);
    expect(body.reply.length).toBeLessThanOrEqual(AI_LIMITS.maxReplyChars);
    expect(body.reply.endsWith(para)).toBe(true);
    expect(body.notices).toContain(SHORTENED_NOTICE);
  });

  it("output cut off at the token limit keeps its completed part; other invalid output is still discarded", async () => {
    const cut = `{"intent":"general","reply":"### Wastegate\\nControls boost by bypassing the turbine.\\n\\n### Blow-off valve\\nVents pressure when the throttle snaps sh`;
    const salvaged = await ask("Explain a wastegate and a blow-off valve in detail", [], cut, { truncated: true });
    expect(salvaged.r.status).toBe(200);
    expect(salvaged.body.reply).toBe("### Wastegate\nControls boost by bypassing the turbine.");
    expect(salvaged.body.proposal).toBeNull();
    expect(salvaged.body.notices).toContain(SHORTENED_NOTICE);
    expect((await ask("Explain turbo lag in detail", [], cut)).r.body).toMatchObject({ ok: false, code: "invalid_output" }); // not a length cut-off
    expect((await ask("Explain turbo lag in detail", [], '{"intent":"gen', { truncated: true })).r.body).toMatchObject({ ok: false, code: "invalid_output" });
  });

  it("provider quota errors still surface as quota", async () => {
    const r = await handleAssistantRequest(request("How does a turbo work?"), deps(async () => ({ ok: false, code: "quota" })));
    expect(r).toMatchObject({ status: 429, body: { ok: false, code: "quota" } });
  });
});

describe("reply text helpers", () => {
  it("cleanReply keeps structure, drops markup and keeps comparisons", () => {
    expect(cleanReply("Line one\r\nLine two\n\n\n\nNext <b>bold</b> <script>alert(1)</script><img src=x onerror=alert(1)>")).toBe("Line one\nLine two\n\nNext bold");
    expect(cleanReply("Keep boost < 10 psi and IAT > 40 °C.")).toBe("Keep boost < 10 psi and IAT > 40 °C.");
  });

  it("clipText and completedPart never end on half a sentence or a dangling heading", () => {
    expect(clipText("A.\n\nB is longer.\n\n### C\nMore text that does not fit", 30)).toEqual({ text: "A.\n\nB is longer.", clipped: true });
    expect(completedPart("First sentence. Second is cut mid")).toBe("First sentence.");
    expect(completedPart("- one\n- two\n- thr")).toBe("- one\n- two");
    expect(completedPart("Intro.\n\n| a | b |\n|---|---|\n| c | d |\n| e | f")).toBe("Intro.\n\n| a | b |\n|---|---|\n| c | d |"); // complete rows kept
    expect(completedPart("Intro.\n\n| a | b |\n|---|---|\n| c")).toBe("Intro."); // header without rows dropped
    expect(salvageReply('{"intent":"general","reply":"Tab\\tquote \\" unicode \\u00b0C')).toBe('Tab\tquote " unicode °C');
    expect(salvageReply('{"intent":"general"')).toBeNull();
  });
});

describe("Gemini request configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetProviderHealth();
  });

  it("defaults to a 4,096-token ceiling and explains a lower configured cap", () => {
    expect(aiConfig().maxOutputTokens).toBe(4096);
    vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "1024");
    expect(aiConfig().maxOutputTokens).toBe(1024);
    expect(aiConfig().configNotes.join(" ")).toMatch(/AI_MAX_OUTPUT_TOKENS=1024 is below the 4096-token budget/);
  });

  it("sends the per-depth budget (bounded by the ceiling) and reports MAX_TOKENS cut-offs", async () => {
    vi.stubEnv("GEMINI_API_KEY", "AIzaSyTESTKEY_abcdefghijklmnopqrstuv");
    const bodies: { generationConfig?: { maxOutputTokens?: number } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: '{"intent":"general","reply":"cut' }] }, finishReason: "MAX_TOKENS" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const r = await geminiCaller([{ role: "user", parts: [{ text: "hi" }] }], new AbortController().signal, { maxOutputTokens: OUTPUT_BUDGET.standard });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(bodies[0].generationConfig?.maxOutputTokens).toBe(2048);
    vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "1024");
    await geminiCaller([{ role: "user", parts: [{ text: "hi" }] }], new AbortController().signal, { maxOutputTokens: OUTPUT_BUDGET.detailed });
    expect(bodies[1].generationConfig?.maxOutputTokens).toBe(1024);
  });
});

describe("conversation context with longer answers", () => {
  const long = (topic: string) => `### ${topic}\n${"The supercharged AJ-V8 family differs by generation, so the year matters. ".repeat(40)}\n\n| Gen | Notes |\n|---|---|\n| Early | Nikasil liners |`;

  it("assistant turns are sent compactly and within budget; the user's words are untouched", () => {
    const c = compactTurn(long("Reliability"));
    expect(c.length).toBeLessThanOrEqual(AI_LIMITS.maxHistoryChars);
    expect(c).not.toMatch(/^###|\|---/m);
    const h = historyFor([
      { role: "user", text: "Do jaguars purr?" },
      { role: "assistant", text: "Do you mean Jaguar cars or the animal?", kind: "local", localKind: "clarify" },
      { role: "user", text: "I'm talking about the V8 Jaguar." },
      { role: "assistant", text: long("Jaguar V8s") },
      { role: "user", text: "What models are there?" },
      { role: "assistant", text: long("Models") },
      { role: "user", text: "Which ones are supercharged?" },
      { role: "assistant", text: long("Supercharged") },
      { role: "user", text: "What about reliability?" },
      { role: "assistant", text: long("Reliability") },
    ]);
    expect(h.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(AI_LIMITS.maxHistoryTotalChars);
    expect(h.some((t) => t.text === "I'm talking about the V8 Jaguar.")).toBe(true); // subject anchor kept
    expect(h.at(-1)!.role).toBe("assistant");
  });

  it("Jaguar regression: every follow-up keeps the Jaguar V8 subject and gets a fitting response guide", async () => {
    // The transcript the browser keeps (long formatted answers); each request sends historyFor(transcript).
    const transcript: (Turn & { kind?: string; localKind?: string })[] = [
      { role: "user", text: "Do Jaguars purr?" },
      { role: "assistant", text: "Do you mean Jaguar cars or the animal?", kind: "local", localKind: "clarify" },
    ];
    expect(classifyRelevance("Do Jaguars purr?", { history: [], hasVehicle: false, hasResults: false }).decision).toBe("clarify");
    const steps: [string, RegExp][] = [
      ["I'm talking about the V8 Jaguar.", /Depth: standard/],
      ["What models are there?", /FOLLOW-UP: yes[\s\S]*Follow-up: build on the earlier answers/],
      ["Which ones are supercharged?", /Follow-up: build on the earlier answers/],
      ["What about reliability?", /Depth: standard/],
      ["Which one would you recommend and why?", /Recommendation: reason from the trade-offs/],
    ];
    for (const [message, guide] of steps) {
      const { body, turn, m } = await ask(message, historyFor(transcript), general(`Answer about ${message}`));
      expect(body.local, message).toBeUndefined();
      expect(m, message).toHaveBeenCalledTimes(1);
      expect(turn, message).toMatch(/CONVERSATION SUBJECT .*: Jaguar · V8/);
      expect(turn, message).toMatch(guide);
      transcript.push({ role: "user", text: message }, { role: "assistant", text: long(message) });
    }
    const cows = await ask("Do cows hibernate?", historyFor(transcript));
    expect(cows.body.local).toBe("off_topic");
    expect(cows.m).not.toHaveBeenCalled();
  });

  it("explicit depth follow-ups are allowed in a car conversation and not outside one", async () => {
    const turbo: Turn[] = [
      { role: "user", text: "How does a turbocharger work?" },
      { role: "assistant", text: "Exhaust spins a turbine that drives a compressor." },
    ];
    for (const q of ["Give me the technical explanation.", "Explain it like I'm a beginner.", "Go deeper.", "Break down every part."]) {
      const { body, turn } = await ask(q, turbo);
      expect(body.local, q).toBeUndefined();
      expect(turn, q).toMatch(/CONVERSATION SUBJECT .*turbochargers/);
    }
    const fresh = await ask("Give me the technical explanation.");
    expect(fresh.body.local).toBeDefined();
    expect(fresh.m).not.toHaveBeenCalled();
  });

  it("a component comparison keeps its subject for the follow-up question", async () => {
    const history: Turn[] = [
      { role: "user", text: "What's the difference between a wastegate and a blow-off valve?" },
      { role: "assistant", text: "A wastegate controls boost on the exhaust side; a blow-off valve vents intake pressure." },
    ];
    const { body, turn } = await ask("Which one is more important?", history);
    expect(body.local).toBeUndefined();
    expect(turn).toMatch(/CONVERSATION SUBJECT .*wastegates, blow-off valves/);
  });

  it("an ordinary automotive explanation never becomes a simulation proposal", async () => {
    const { body } = await ask("How does a supercharger work?", [], general("A supercharger is driven by the crankshaft.", { changes: [{ scenario: "modified", field: "power", operation: "change", value: 50, unit: "hp", option: "", reason: "x" }] }));
    expect(body.proposal).toBeNull();
  });
});
