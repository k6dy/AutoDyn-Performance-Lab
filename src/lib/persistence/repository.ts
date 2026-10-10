// Local-first storage for saved analyses (IndexedDB). Metadata and the heavy payload (results,
// chart data) live in separate object stores written in one transaction, so the list view never
// loads every result. Falls back to an in-memory store when IndexedDB is unavailable.

import { req, STORES, transact } from "@/lib/persistence/db";
import { parseMeta, parseSaved, type SavedAnalysis, type SavedMeta } from "@/lib/persistence/schema";
import { metaOf } from "@/lib/persistence/snapshot";

export type StorageErrorCode = "quota" | "unavailable" | "corrupt" | "not_found" | "unknown";

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export const STORAGE_MESSAGES: Record<StorageErrorCode, string> = {
  quota: "Browser storage is full. Delete or export older analyses, then try again.",
  unavailable: "This browser isn't allowing AutoDyn to store data (private browsing or blocked site data).",
  corrupt: "This saved analysis is damaged and can't be opened. Nothing else was affected.",
  not_found: "That saved analysis no longer exists.",
  unknown: "The browser couldn't complete the storage operation.",
};

export function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "QuotaExceededError" || /quota/i.test(String((err as Error)?.message ?? ""))) return new StorageError("quota", STORAGE_MESSAGES.quota);
  if (name === "InvalidStateError" || name === "SecurityError" || name === "UnknownError") return new StorageError("unavailable", STORAGE_MESSAGES.unavailable);
  return new StorageError("unknown", STORAGE_MESSAGES.unknown);
}

export type ListResult = { items: SavedMeta[]; unreadable: string[] };

export interface AnalysisRepository {
  /** False for the in-memory fallback: data is lost when the tab closes. */
  readonly persistent: boolean;
  list(): Promise<ListResult>;
  /** Full record, validated. Throws StorageError("corrupt" | "not_found"). */
  get(id: string): Promise<SavedAnalysis>;
  findByFingerprint(fingerprint: string): Promise<SavedMeta | null>;
  put(record: SavedAnalysis): Promise<void>;
  /** Writes several records atomically (all or nothing). */
  putMany(records: SavedAnalysis[]): Promise<void>;
  updateMeta(id: string, patch: Partial<Pick<SavedMeta, "title" | "customTitle" | "updatedAt">>): Promise<SavedMeta>;
  delete(id: string): Promise<void>;
  /** Removes a set of records (e.g. unreadable ones) — only ever called on explicit user action. */
  deleteMany(ids: string[]): Promise<void>;
  clear(): Promise<void>;
}

const newestFirst = (a: SavedMeta, b: SavedMeta) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

// ---- IndexedDB --------------------------------------------------------------------------------

const META = STORES.analyses;
const PAYLOAD = STORES.payloads;

export class IndexedDbRepository implements AnalysisRepository {
  readonly persistent = true;

  constructor(private factory: IDBFactory = globalThis.indexedDB) {}

  private async run<T>(mode: IDBTransactionMode, fn: (meta: IDBObjectStore, payload: IDBObjectStore) => Promise<T> | T): Promise<T> {
    try {
      return await transact(this.factory, [META, PAYLOAD], mode, (s) => fn(s[META], s[PAYLOAD]));
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async list(): Promise<ListResult> {
    const raw = await this.run("readonly", (meta) => req(meta.getAll()));
    const items: SavedMeta[] = [];
    const unreadable: string[] = [];
    for (const r of raw as unknown[]) {
      const m = parseMeta(r);
      if (m) items.push(m);
      else unreadable.push(String((r as { id?: unknown })?.id ?? "unknown").slice(0, 80));
    }
    return { items: items.sort(newestFirst), unreadable };
  }

  async get(id: string): Promise<SavedAnalysis> {
    const [m, p] = await this.run("readonly", (meta, payload) => Promise.all([req(meta.get(id)), req(payload.get(id))]));
    if (!m) throw new StorageError("not_found", STORAGE_MESSAGES.not_found);
    if (!p) throw new StorageError("corrupt", STORAGE_MESSAGES.corrupt);
    const parsed = parseSaved({ ...(m as object), baseline: (p as { baseline?: unknown }).baseline ?? null, result: (p as { result?: unknown }).result });
    if (!parsed.ok) throw new StorageError("corrupt", STORAGE_MESSAGES.corrupt);
    return parsed.record;
  }

  async findByFingerprint(fingerprint: string): Promise<SavedMeta | null> {
    const raw = await this.run("readonly", (meta) => req(meta.index("fingerprint").getAll(fingerprint)));
    const items = (raw as unknown[]).map(parseMeta).filter((m): m is SavedMeta => !!m);
    return items.sort(newestFirst)[0] ?? null;
  }

  async put(record: SavedAnalysis) {
    await this.putMany([record]);
  }

  async putMany(records: SavedAnalysis[]) {
    await this.run("readwrite", (meta, payload) => {
      for (const r of records) {
        meta.put(metaOf(r));
        payload.put({ id: r.id, baseline: r.baseline, result: r.result });
      }
    });
  }

  async updateMeta(id: string, patch: Partial<Pick<SavedMeta, "title" | "customTitle" | "updatedAt">>) {
    return this.run("readwrite", async (meta) => {
      const current = parseMeta(await req(meta.get(id)));
      if (!current) throw new StorageError("not_found", STORAGE_MESSAGES.not_found);
      const next = { ...current, ...patch };
      meta.put(next);
      return next;
    });
  }

  async delete(id: string) {
    await this.deleteMany([id]);
  }

  async deleteMany(ids: string[]) {
    await this.run("readwrite", (meta, payload) => {
      for (const id of ids) {
        meta.delete(id);
        payload.delete(id);
      }
    });
  }

  async clear() {
    await this.run("readwrite", (meta, payload) => {
      meta.clear();
      payload.clear();
    });
  }
}

// ---- In-memory (fallback and tests) ------------------------------------------------------------

export class MemoryRepository implements AnalysisRepository {
  readonly persistent: boolean;
  private records = new Map<string, unknown>();
  /** Test hook: the next write fails with this error. */
  failNextWrite: StorageError | null = null;

  constructor(opts: { persistent?: boolean } = {}) {
    this.persistent = opts.persistent ?? false;
  }

  private write() {
    if (this.failNextWrite) {
      const e = this.failNextWrite;
      this.failNextWrite = null;
      throw e;
    }
  }

  /** Test hook: store an arbitrary (possibly corrupt) raw record. */
  putRaw(id: string, raw: unknown) {
    this.records.set(id, raw);
  }

  async list(): Promise<ListResult> {
    const items: SavedMeta[] = [];
    const unreadable: string[] = [];
    for (const [id, raw] of this.records) {
      const m = parseMeta(raw);
      if (m) items.push(m);
      else unreadable.push(id);
    }
    return { items: items.sort(newestFirst), unreadable };
  }

  async get(id: string) {
    if (!this.records.has(id)) throw new StorageError("not_found", STORAGE_MESSAGES.not_found);
    const parsed = parseSaved(structuredClone(this.records.get(id)));
    if (!parsed.ok) throw new StorageError("corrupt", STORAGE_MESSAGES.corrupt);
    return parsed.record;
  }

  async findByFingerprint(fingerprint: string) {
    return (await this.list()).items.find((m) => m.fingerprint === fingerprint) ?? null;
  }

  async put(record: SavedAnalysis) {
    await this.putMany([record]);
  }

  async putMany(records: SavedAnalysis[]) {
    this.write();
    for (const r of records) this.records.set(r.id, structuredClone(r));
  }

  async updateMeta(id: string, patch: Partial<Pick<SavedMeta, "title" | "customTitle" | "updatedAt">>) {
    this.write();
    const raw = this.records.get(id) as SavedAnalysis | undefined;
    const meta = parseMeta(raw ? metaOf(raw) : null);
    if (!raw || !meta) throw new StorageError("not_found", STORAGE_MESSAGES.not_found);
    const next = { ...raw, ...patch };
    this.records.set(id, next);
    return { ...meta, ...patch };
  }

  async delete(id: string) {
    this.records.delete(id);
  }

  async deleteMany(ids: string[]) {
    for (const id of ids) this.records.delete(id);
  }

  async clear() {
    this.records.clear();
  }
}

// ---- Shared instance ---------------------------------------------------------------------------

let shared: AnalysisRepository | null = null;

export function getRepository(): AnalysisRepository {
  if (shared) return shared;
  const idb = typeof globalThis !== "undefined" ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : undefined;
  shared = idb ? new IndexedDbRepository(idb) : new MemoryRepository();
  return shared;
}

/** Tests and the in-memory fallback after IndexedDB refuses to open. */
export function setRepository(repo: AnalysisRepository | null) {
  shared = repo;
}
