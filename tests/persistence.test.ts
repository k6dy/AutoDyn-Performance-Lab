import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { lbToKg } from "@/lib/units";
import { userValue, setModifiedValue } from "@/lib/domain/scenario";
import type { AnalysisConfig } from "@/lib/domain/types";
import { autosave, replaceOriginal, saveAs, toActive } from "@/lib/persistence/autosave";
import { buildBackup, ImportError, planImport } from "@/lib/persistence/backup";
import { DRAFT_KEY, parseDraft } from "@/lib/persistence/draft";
import { verifyRecord } from "@/lib/persistence/integrity";
import { IndexedDbRepository, MemoryRepository, StorageError, toStorageError, type AnalysisRepository } from "@/lib/persistence/repository";
import { parseSaved, type SavedAnalysis } from "@/lib/persistence/schema";
import { buildRecord, duplicateRecord, fingerprint, hasMeaningfulEdits, isHistorical, metaOf, stableStringify } from "@/lib/persistence/snapshot";
import { ENGINE_VERSION, runAnalysis } from "@/lib/physics/analysis";
import { c300, config } from "./support/fixtures";

const base = () => config(c300());
const modified = (hp = 40): AnalysisConfig => {
  const c = base();
  return setModifiedValue({ ...c, modified: { overrides: {} } }, "peakPowerKw", userValue(c.stock!.values.peakPowerKw.value! + hp * 0.7457));
};
const record = (c: AnalysisConfig = base(), extra: Partial<SavedAnalysis> = {}): SavedAnalysis => ({
  ...buildRecord({ result: runAnalysis(c), baseline: c.stock, units: "imperial", origin: "auto" }),
  ...extra,
});

let repo: AnalysisRepository;
beforeEach(() => {
  repo = new IndexedDbRepository(new IDBFactory());
});

describe("IndexedDB repository", () => {
  it("stores, lists (metadata only) and restores the exact snapshot", async () => {
    const r = record(modified());
    await repo.put(r);
    const list = await repo.list();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toEqual(metaOf(r));
    expect(list.items[0]).not.toHaveProperty("result");
    const back = await repo.get(r.id);
    expect(back.result).toEqual(r.result); // charts, metrics, feasibility: identical
    expect(back.result.stock.samples).toEqual(r.result.stock.samples);
    expect(back.result.modified!.metrics).toEqual(r.result.modified!.metrics);
  });

  it("keeps multiple analyses side by side, newest first", async () => {
    const a = record(base(), { updatedAt: "2026-01-01T00:00:00.000Z" });
    const b = record(modified(), { updatedAt: "2026-02-01T00:00:00.000Z" });
    await repo.putMany([a, b]);
    expect((await repo.list()).items.map((m) => m.id)).toEqual([b.id, a.id]);
  });

  it("renames, duplicates independently and deletes individual records", async () => {
    const a = record(modified());
    await repo.put(a);
    const renamed = await repo.updateMeta(a.id, { title: "Track build", customTitle: true });
    expect(renamed.title).toBe("Track build");
    const copy = duplicateRecord(await repo.get(a.id));
    await repo.put(copy);
    expect(copy.id).not.toBe(a.id);
    expect(copy.sourceId).toBe(a.id);
    expect(copy.result).toEqual(a.result);
    await repo.delete(a.id);
    const ids = (await repo.list()).items.map((m) => m.id);
    expect(ids).toEqual([copy.id]); // the copy survives deleting the original
    await expect(repo.get(a.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("clear removes everything", async () => {
    await repo.putMany([record(), record(modified())]);
    await repo.clear();
    expect((await repo.list()).items).toEqual([]);
  });

  it("corrupted stored records fail safely: listed as unreadable, never crash, others unaffected", async () => {
    const good = record();
    await repo.put(good);
    const factory = new IDBFactory();
    const r2 = new IndexedDbRepository(factory);
    await r2.put(good);
    // Write garbage directly into the store, as an older/buggy build might have.
    await new Promise<void>((resolve, reject) => {
      const open = factory.open("autodyn");
      open.onsuccess = () => {
        const tx = open.result.transaction(["analyses", "payloads"], "readwrite");
        tx.objectStore("analyses").put({ id: "broken0001", title: 42, schema: 1 });
        tx.objectStore("analyses").put({ ...metaOf(good), id: "nopayload1" });
        tx.objectStore("payloads").put({ id: "nopayload1", baseline: null, result: { stock: "nonsense" } });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
    });
    const list = await r2.list();
    expect(list.unreadable).toEqual(["broken0001"]);
    expect(list.items.map((m) => m.id).sort()).toEqual([good.id, "nopayload1"].sort());
    await expect(r2.get("nopayload1")).rejects.toMatchObject({ code: "corrupt" });
    expect((await r2.get(good.id)).id).toBe(good.id);
  });

  it("maps quota failures to a recoverable storage error", () => {
    expect(toStorageError(new DOMException("full", "QuotaExceededError")).code).toBe("quota");
    expect(toStorageError(new DOMException("x", "InvalidStateError")).code).toBe("unavailable");
  });

  it("rejects records from an unknown schema version instead of misreading them", () => {
    const r = record();
    expect(parseSaved({ ...r, schema: 2 }).ok).toBe(false);
    expect(parseSaved({ ...r, result: { ...r.result, stock: { ...r.result.stock, metrics: { ...r.result.stock.metrics, zeroTo60S: "fast" } } } }).ok).toBe(false);
    expect(parseSaved(r).ok).toBe(true);
  });
});

describe("automatic saving", () => {
  it("a completed run is saved; re-running the identical configuration does not add entries", async () => {
    const result = runAnalysis(base());
    const first = await autosave(repo, { result, baseline: null, units: "imperial", active: null, recalculatedFrom: null });
    expect(first.action).toBe("created");
    const again = await autosave(repo, { result: runAnalysis(base()), baseline: null, units: "imperial", active: toActive(first.meta), recalculatedFrom: null });
    expect(again.action).toBe("linked");
    // Even without a linked record (e.g. after New Analysis), identical inputs reuse the entry.
    const fresh = await autosave(repo, { result: runAnalysis(base()), baseline: null, units: "imperial", active: null, recalculatedFrom: null });
    expect(fresh.action).toBe("linked");
    expect((await repo.list()).items).toHaveLength(1);
  });

  it("a changed re-run updates the linked analysis; a new vehicle or New Analysis creates another", async () => {
    const first = await autosave(repo, { result: runAnalysis(base()), baseline: null, units: "imperial", active: null, recalculatedFrom: null });
    const updated = await autosave(repo, { result: runAnalysis(modified()), baseline: null, units: "imperial", active: toActive(first.meta), recalculatedFrom: null });
    expect(updated.action).toBe("updated");
    expect(updated.meta.id).toBe(first.meta.id);
    expect(updated.meta.summary.scenarios).toBe("compare");
    expect(updated.meta.title).toMatch(/Stock vs Modified · \+40 hp/);
    const other = await autosave(repo, { result: runAnalysis(modified(80)), baseline: null, units: "imperial", active: null, recalculatedFrom: null });
    expect(other.action).toBe("created");
    expect((await repo.list()).items).toHaveLength(2);
  });

  it("user-named titles survive updates", async () => {
    const first = await autosave(repo, { result: runAnalysis(base()), baseline: null, units: "imperial", active: null, recalculatedFrom: null });
    const named = await repo.updateMeta(first.meta.id, { title: "Weekend car", customTitle: true });
    const updated = await autosave(repo, { result: runAnalysis(modified()), baseline: null, units: "imperial", active: toActive(named), recalculatedFrom: null });
    expect(updated.meta.title).toBe("Weekend car");
  });

  it("historical snapshots are never overwritten implicitly; replacing requires an explicit call", async () => {
    const old = record(base(), { engineVersion: "autodyn-physics/1.0.0" });
    old.result = { ...old.result, engineVersion: "autodyn-physics/1.0.0" };
    old.fingerprint = fingerprint(old.result.config, old.engineVersion);
    await repo.put(old);
    expect(isHistorical(old)).toBe(true);
    const recalculated = await autosave(repo, { result: runAnalysis(base()), baseline: null, units: "imperial", active: toActive(old), recalculatedFrom: { id: old.id, title: old.title } });
    expect(recalculated.action).toBe("created");
    expect(recalculated.meta.origin).toBe("recalculated");
    expect(recalculated.meta.sourceId).toBe(old.id);
    expect((await repo.get(old.id)).engineVersion).toBe("autodyn-physics/1.0.0"); // original preserved
    const replaced = await replaceOriginal(repo, old.id, recalculated.meta.id);
    expect(replaced.id).toBe(old.id);
    expect(replaced.engineVersion).toBe(ENGINE_VERSION);
    expect((await repo.list()).items.map((m) => m.id)).toEqual([old.id]);
  });

  it("Save as keeps a separately named copy", async () => {
    const first = await autosave(repo, { result: runAnalysis(base()), baseline: null, units: "imperial", active: null, recalculatedFrom: null });
    const copy = await saveAs(repo, { result: runAnalysis(base()), baseline: null, units: "imperial", title: "  Baseline v1 ", sourceId: first.meta.id });
    expect(copy.title).toBe("Baseline v1");
    expect(copy.customTitle).toBe(true);
    expect((await repo.list()).items).toHaveLength(2);
  });

  it("a storage-full error is surfaced (not swallowed) and the next attempt succeeds", async () => {
    const mem = new MemoryRepository({ persistent: true });
    mem.failNextWrite = new StorageError("quota", "full");
    await expect(autosave(mem, { result: runAnalysis(base()), baseline: null, units: "imperial", active: null, recalculatedFrom: null })).rejects.toMatchObject({ code: "quota" });
    expect((await mem.list()).items).toHaveLength(0);
    const ok = await autosave(mem, { result: runAnalysis(base()), baseline: null, units: "imperial", active: null, recalculatedFrom: null });
    expect(ok.action).toBe("created");
  });

  it("stock and modified values are stored independently and in SI units", async () => {
    const c = setModifiedValue(modified(), "curbMassKg", { value: base().stock!.values.curbMassKg.value! - lbToKg(150), delta: -lbToKg(150), provenance: "user" });
    const saved = record(c);
    await repo.put(saved);
    const back = await repo.get(saved.id);
    expect(back.result.config.stock!.values.curbMassKg.value).toBeCloseTo(lbToKg(3549), 6);
    expect(back.result.config.modified!.overrides.curbMassKg!.delta).toBeCloseTo(-lbToKg(150), 9);
    expect(back.result.modified!.inputs.curbMassKg).toBeCloseTo(lbToKg(3549 - 150), 6);
    expect(back.summary.stockMassKg).toBeCloseTo(lbToKg(3549), 6);
  });
});

describe("fingerprints and unsaved edits", () => {
  it("are stable across key order and unit round-trip float noise", () => {
    const c = base();
    const noisy = structuredClone(c);
    noisy.stock!.values.curbMassKg.value = lbToKg(c.stock!.values.curbMassKg.value! / 0.45359237);
    expect(fingerprint(noisy)).toBe(fingerprint(c));
    expect(stableStringify({ b: 1, a: [1, undefined] })).toBe(stableStringify({ a: [1, null], b: 1 }));
    expect(fingerprint(modified())).not.toBe(fingerprint(c));
    expect(fingerprint(c, "autodyn-physics/1.0.0")).not.toBe(fingerprint(c));
  });

  it("detects meaningful edits relative to the vehicle source or the linked analysis", () => {
    const c = base();
    expect(hasMeaningfulEdits(c, c.stock, null)).toBe(false); // just a selected vehicle
    expect(hasMeaningfulEdits(modified(), c.stock, null)).toBe(true);
    const meta = metaOf(record(modified()));
    expect(hasMeaningfulEdits(modified(), c.stock, meta)).toBe(false);
    expect(hasMeaningfulEdits(modified(60), c.stock, meta)).toBe(true);
  });
});

describe("JSON backup", () => {
  it("round-trips through export and import", async () => {
    const a = record(modified());
    const text = buildBackup([a]);
    const plan = planImport(text, []);
    expect(plan.rejected).toEqual([]);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0].result).toEqual(a.result);
    expect(plan.accepted[0].origin).toBe("import");
    await repo.putMany(plan.accepted);
    expect(verifyRecord(await repo.get(a.id))).toBe(true);
  });

  it("explains unsupported and malformed files", () => {
    expect(() => planImport("{not json", [])).toThrow(ImportError);
    expect(() => planImport(JSON.stringify([1, 2]), [])).toThrow(/isn't an AutoDyn analyses backup/);
    expect(() => planImport(JSON.stringify({ app: "AutoDyn Performance Lab", engineVersion: "x" }), [])).toThrow(/report export/);
    expect(() => planImport(JSON.stringify({ format: "autodyn-analyses", formatVersion: 9, analyses: [] }), [])).toThrow(/newer AutoDyn/);
    expect(() => planImport(JSON.stringify({ format: "autodyn-analyses", formatVersion: 1 }), [])).toThrow(/no analyses list/);
    expect(() => planImport("x".repeat(51 * 1024 * 1024), [])).toThrow(/larger than/);
  });

  it("validates each record: bad numbers, missing fields, invalid inputs and tampered results are rejected", () => {
    const good = record(modified());
    const badNumber = JSON.parse(JSON.stringify(good));
    badNumber.result.stock.metrics.zeroTo60S = "1e999";
    const missing = JSON.parse(JSON.stringify(good));
    delete missing.result;
    const invalidInput = JSON.parse(JSON.stringify(good));
    invalidInput.result.config.stock.values.curbMassKg.value = 0.45; // 1 lb
    const tampered = JSON.parse(JSON.stringify(good));
    tampered.id = "tampered01";
    tampered.result.stock.metrics.zeroTo60S = 0.9;
    const html = JSON.parse(JSON.stringify(good));
    html.id = "htmltitle1";
    html.title = "<img src=x onerror=alert(1)>";
    const plan = planImport(JSON.stringify({ format: "autodyn-analyses", formatVersion: 1, analyses: [badNumber, missing, invalidInput, tampered, html, "junk"] }), []);
    expect(plan.rejected.map((r) => r.index)).toEqual([0, 1, 2, 5]);
    expect(plan.rejected[2].reason).toMatch(/physically invalid/);
    // Structurally valid but edited results are imported, then fail verification when opened.
    const t = plan.accepted.find((r) => r.id === "tampered01")!;
    expect(verifyRecord(t)).toBe(false);
    // Text is kept as inert data (React renders it as text, never as HTML).
    expect(plan.accepted.find((r) => r.id === "htmltitle1")!.title).toBe("<img src=x onerror=alert(1)>");
  });

  it("handles duplicate IDs without touching existing history", async () => {
    const a = record(modified());
    await repo.put(a);
    const existing = (await repo.list()).items;
    // Same record again: skipped.
    expect(planImport(buildBackup([a]), existing)).toMatchObject({ skipped: 1, accepted: [] });
    // Same id, different content: imported under a new id; the original is untouched.
    const changed = { ...record(base()), id: a.id };
    const plan = planImport(buildBackup([changed, changed]), existing);
    expect(plan.reassigned).toBe(2);
    expect(new Set(plan.accepted.map((r) => r.id)).size).toBe(2);
    expect(plan.accepted.every((r) => r.id !== a.id)).toBe(true);
    await repo.putMany(plan.accepted);
    expect((await repo.get(a.id)).result).toEqual(a.result);
    expect((await repo.list()).items).toHaveLength(3);
  });

  it("recomputes derived fields instead of trusting the file", () => {
    const a = record(modified());
    const forged = { ...a, fingerprint: "forged", summary: { ...a.summary, stockPowerKw: 9999 } };
    const [imported] = planImport(buildBackup([forged]), []).accepted;
    expect(imported.fingerprint).toBe(a.fingerprint);
    expect(imported.summary.stockPowerKw).toBe(a.summary.stockPowerKw);
  });
});

describe("workspace draft", () => {
  it("validates, sanitizes and never applies a corrupted or 1 lb draft", () => {
    const c = base();
    expect(parseDraft({ version: 4, config: { bogus: true } })).toBeNull();
    expect(parseDraft({ version: 2, config: c })).toBeNull();
    const bad = structuredClone(c);
    bad.stock!.values.curbMassKg = { value: lbToKg(1), provenance: "user" };
    const d = parseDraft({ version: 4, savedAt: 1, config: bad, baseline: c.stock, activeId: "<script>", messages: [{ role: "system", text: "x" }, { id: 1, role: "user", text: "hi" }] })!;
    expect(d.fixes).toEqual(["Stock vehicle weight (curb)"]);
    expect(d.config.stock!.values.curbMassKg.value).toBeCloseTo(lbToKg(3549), 6);
    expect(d.activeId).toBeNull();
    expect(d.messages).toEqual([{ id: "1", role: "user", text: "hi", createdAt: 0, notices: undefined }]);
  });

  it("drops a baseline that belongs to a different vehicle", () => {
    const c = base();
    const other = structuredClone(c.stock!);
    other.identity = { ...other.identity, model: "E350" };
    other.values.curbMassKg = { value: 1900, provenance: "verified" };
    const d = parseDraft({ version: 4, config: c, baseline: other })!;
    expect(d.baseline).toBeNull();
    expect(d.config.stock!.values.curbMassKg.value).toBeCloseTo(lbToKg(3549), 6);
    expect(DRAFT_KEY).toBe("autodyn:draft:v4");
  });
});
