import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { historyFor, omittedCount } from "@/lib/ai/history";
import { DEFAULT_TITLE, generateTitle } from "@/lib/ai/titles";
import { AI_LIMITS } from "@/lib/ai/types";
import {
  IndexedDbConversations,
  MAX_CONVERSATION_MESSAGES,
  MemoryConversations,
  parseConversation,
  withDerived,
  type Conversation,
  type ConversationRepository,
  type StoredMessage,
} from "@/lib/persistence/conversations";
import { IndexedDbRepository, StorageError } from "@/lib/persistence/repository";
import { buildRecord } from "@/lib/persistence/snapshot";
import { runAnalysis } from "@/lib/physics/analysis";
import { c300, config } from "./support/fixtures";

const msg = (id: string, role: "user" | "assistant", text: string, extra: Partial<StoredMessage> = {}): StoredMessage => ({ id, role, text, createdAt: Number(id.replace(/\D/g, "")) || 1, ...extra });

function convo(id: string, messages: StoredMessage[], extra: Partial<Conversation> = {}): Conversation {
  return withDerived({
    id,
    title: "Turbochargers",
    customTitle: false,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:05:00.000Z",
    vehicleLabel: null,
    analysisIds: [],
    messages,
    vehicle: null,
    ...extra,
  });
}

let factory: IDBFactory;
let repo: ConversationRepository;
beforeEach(() => {
  factory = new IDBFactory();
  repo = new IndexedDbConversations(factory);
});

describe("formatted answers in storage", () => {
  it("a long Markdown answer is stored and restored verbatim (line breaks, lists, tables)", async () => {
    const answer = `### Wastegate\nBypasses the turbine.\n\n- one\n- two\n\n| Part | Side |\n|---|---|\n| WG | Exhaust |\n\n${"Detail sentence about boost control. ".repeat(140)}`.trim();
    expect(answer.length).toBeGreaterThan(AI_LIMITS.maxReplyChars - 1000);
    await repo.put(convo("chat000777", [msg("u1", "user", "Explain a wastegate in detail"), msg("a2", "assistant", answer)]));
    const back = await repo.get("chat000777");
    expect(back.messages[1].text).toBe(answer);
    expect(parseConversation(back, { id: back.id, messages: back.messages, vehicle: null })?.messages[1].text).toBe(answer);
  });
});

describe("conversation storage", () => {
  it("saves a conversation and restores the exact ordered transcript", async () => {
    const c = convo("chat000001", [msg("u1", "user", "How does a turbo work?"), msg("a2", "assistant", "It uses exhaust energy…"), msg("u3", "user", "What about reliability?")]);
    await repo.put(c);
    const back = await repo.get("chat000001");
    expect(back.messages.map((m) => m.id)).toEqual(["u1", "a2", "u3"]);
    expect(back).toEqual(c);
    const { items } = await repo.list();
    expect(items[0]).toMatchObject({ id: "chat000001", messageCount: 3, preview: "What about reliability?" });
    expect(items[0]).not.toHaveProperty("messages");
  });

  it("keeps conversations isolated and lists newest first", async () => {
    await repo.put(convo("chat000001", [msg("u1", "user", "turbo?")], { updatedAt: "2026-10-01T00:00:00.000Z" }));
    await repo.put(convo("chat000002", [msg("u1", "user", "brakes?")], { updatedAt: "2026-10-02T00:00:00.000Z" }));
    expect((await repo.list()).items.map((m) => m.id)).toEqual(["chat000002", "chat000001"]);
    expect((await repo.get("chat000001")).messages[0].text).toBe("turbo?");
    expect((await repo.get("chat000002")).messages[0].text).toBe("brakes?");
  });

  it("renames, deletes one, and clears all — without touching saved analyses", async () => {
    const analyses = new IndexedDbRepository(factory); // same database, separate stores
    const analysis = buildRecord({ result: runAnalysis(config(c300())), baseline: null, units: "imperial", origin: "auto" });
    await analyses.put(analysis);
    await repo.put(convo("chat000001", [msg("u1", "user", "x")], { analysisIds: [analysis.id] }));
    await repo.put(convo("chat000002", [msg("u1", "user", "y")]));
    await repo.rename("chat000001", "C300 tuning");
    expect((await repo.get("chat000001")).title).toBe("C300 tuning");
    expect((await repo.get("chat000001")).customTitle).toBe(true);
    await repo.delete("chat000001");
    await expect(repo.get("chat000001")).rejects.toMatchObject({ code: "not_found" });
    await repo.clear();
    expect((await repo.list()).items).toEqual([]);
    expect((await analyses.get(analysis.id)).id).toBe(analysis.id); // analysis intact
  });

  it("files a late reply into its own conversation without duplicating it", async () => {
    await repo.put(convo("chat000001", [msg("u1", "user", "How do DCTs work?")]));
    const reply = msg("a-u1", "assistant", "Two clutches pre-select gears…");
    await repo.append("chat000001", reply);
    await repo.append("chat000001", reply);
    expect((await repo.get("chat000001")).messages.map((m) => m.id)).toEqual(["u1", "a-u1"]);
    await expect(repo.append("missing001", reply)).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects malformed records safely and never stores secrets-like extra fields", async () => {
    const mem = new MemoryConversations({ persistent: true });
    mem.putRaw("broken0001", { id: "broken0001", title: 7 }, null);
    const good = convo("chat000001", [msg("u1", "user", "turbo")]);
    mem.putRaw("chat000001", { ...good, messages: undefined, vehicle: undefined }, { id: "chat000001", messages: [{ id: "u1", role: "system", text: "x", createdAt: 1 }], vehicle: null });
    const list = await mem.list();
    expect(list.unreadable).toEqual(["broken0001"]);
    await expect(mem.get("chat000001")).rejects.toMatchObject({ code: "corrupt" });
    expect(parseConversation({ ...good, schema: 2 }, { id: good.id, messages: [], vehicle: null })).toBeNull();
    const withExtra = parseConversation({ ...good, apiKey: "AIza-secret" }, { id: good.id, messages: good.messages, vehicle: null, prompt: "hidden" });
    expect(JSON.stringify(withExtra)).not.toMatch(/AIza|hidden/);
  });

  it("surfaces storage failures (quota) to the caller", async () => {
    const mem = new MemoryConversations({ persistent: true });
    mem.failNextWrite = new StorageError("quota", "full");
    await expect(mem.put(convo("chat000001", [msg("u1", "user", "x")]))).rejects.toMatchObject({ code: "quota" });
    await mem.put(convo("chat000001", [msg("u1", "user", "x")]));
    expect((await mem.list()).items).toHaveLength(1);
  });

  it("enforces the per-conversation message cap in the schema", () => {
    const many = Array.from({ length: MAX_CONVERSATION_MESSAGES + 1 }, (_, i) => msg(`u${i}`, "user", "x"));
    expect(parseConversation(convo("chat000001", []), { id: "chat000001", messages: many, vehicle: null })).toBeNull();
  });
});

describe("bounded AI context", () => {
  it("sends only recent eligible turns within count and character budgets", () => {
    const transcript = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `message ${i} ${"x".repeat(900)}` }));
    const h = historyFor(transcript);
    expect(h.length).toBeLessThanOrEqual(AI_LIMITS.maxHistoryTurns);
    expect(h.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(AI_LIMITS.maxHistoryTotalChars);
    expect(h[0].role).toBe("user");
    expect(h.at(-1)!.text.startsWith("message 39")).toBe(true);
    expect(omittedCount(transcript)).toBe(40 - h.length);
  });

  it("never sends locally answered, failed or error messages", () => {
    const h = historyFor([
      { role: "user", text: "Do cows hibernate?", kind: "local" },
      { role: "assistant", text: "I'm here for cars…", kind: "local" },
      { role: "user", text: "How does a turbo work?" },
      { role: "assistant", text: "Exhaust spins a turbine…" },
      { role: "user", text: "What about lag?", failed: true },
      { role: "assistant", text: "Physics engine results…", kind: "results" },
    ]);
    expect(h.map((m) => m.text)).toEqual(["How does a turbo work?", "Exhaust spins a turbine…"]);
  });
});

describe("local conversation titles", () => {
  it.each([
    [["Compare a C300 with an M340i."], null, "C300 vs M340i"],
    [["Compare M340i vs C43 AMG"], null, "M340i vs C43 AMG"],
    [["How do dual-clutch transmissions work?"], null, "Understanding Dual-Clutch Transmissions"],
    [["What would a turbo upgrade do for my car?"], "2015 C300", "2015 C300 — Turbo Upgrade"],
    [["Add 40 hp"], "2015 C300", "2015 C300 — +40 hp"],
    [["How does suspension geometry affect handling?"], null, "Understanding Suspension & Handling"],
    [["What's the difference between a turbo and a supercharger?"], null, "Turbo vs Supercharger"],
    [["What would change if this car weighed 150 pounds less?"], "2015 C300", "2015 C300 — −150 lb"],
    [["hmm"], null, DEFAULT_TITLE],
  ] as [string[], string | null, string][])("%j → %s", (messages, vehicle, expected) => {
    expect(generateTitle(messages, vehicle)).toBe(expected);
  });
});
