// Local-first AI conversation history (IndexedDB, same database as saved analyses but separate
// stores). A conversation references saved analyses by ID only; deleting one never touches the
// other. Only the transcript the user saw is stored — never keys, credentials or server prompts.

import { z } from "zod";
import { specSetSchema } from "@/lib/domain/configSchema";
import type { SpecSet } from "@/lib/domain/types";
import { req, STORES, transact } from "@/lib/persistence/db";
import { STORAGE_MESSAGES, StorageError, toStorageError } from "@/lib/persistence/repository";

export const CONVERSATION_SCHEMA_VERSION = 1;
/** Hard cap per conversation; the UI asks for a new chat when reached (nothing is dropped). */
export const MAX_CONVERSATION_MESSAGES = 1000;
/** Stored message text (Markdown kept verbatim); above the longest reply the assistant returns. */
export const MAX_MESSAGE_TEXT = 8000;

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  /** results: deterministic engine summary · local: answered by the relevance gate (no AI call). */
  kind?: "results" | "local";
  /** For local replies: why the gate answered without the provider (clarify turns stay in context). */
  localKind?: "clarify" | "off_topic" | "injection" | "small_talk" | "app_state";
  notices?: string[];
  /** Official sources shown under the answer (EPA / NHTSA pages, retrieval date). */
  sources?: { label: string; url: string; retrieved: string }[];
  followUp?: string | null;
  /** User message whose request failed; kept for retry, never sent as history. */
  failed?: boolean;
  errorCode?: string;
  /** Saved analysis produced by this message's run. */
  analysisId?: string;
  /** Read-only summary of a proposal attached to an assistant message. */
  proposalNote?: string;
};

export type ConversationMeta = {
  schema: number;
  id: string;
  title: string;
  customTitle: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** Last user message, for search and the list. */
  preview: string;
  vehicleLabel: string | null;
  analysisIds: string[];
};

export type Conversation = ConversationMeta & {
  messages: StoredMessage[];
  /** Vehicle the conversation was about (offered for loading, never applied automatically). */
  vehicle: SpecSet | null;
};

const ID = /^[A-Za-z0-9_-]{6,80}$/;
const iso = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");

type StoredSource = { label: string; url: string; retrieved: string };
export const OFFICIAL_SOURCE_URL = /^https:\/\/(?:www\.)?(?:fueleconomy\.gov|nhtsa\.gov)\//;
const sourceSchema = z.object({ label: z.string().max(200), url: z.string().max(300).regex(OFFICIAL_SOURCE_URL), retrieved: z.string().max(24) });

export const storedMessageSchema = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(MAX_MESSAGE_TEXT),
  createdAt: z.number().finite(),
  kind: z.enum(["results", "local"]).optional(),
  localKind: z.enum(["clarify", "off_topic", "injection", "small_talk", "app_state"]).optional(),
  notices: z.array(z.string().max(600)).max(10).optional(),
  // Only official government pages are kept, so a restored record can't carry arbitrary links; an
  // invalid entry is dropped without discarding the conversation.
  sources: z
    .array(z.unknown())
    .transform((xs) => xs.flatMap((x) => (sourceSchema.safeParse(x).success ? [x as StoredSource] : [])).slice(0, 5))
    .optional(),
  followUp: z.string().max(400).nullable().optional(),
  failed: z.boolean().optional(),
  errorCode: z.string().max(40).optional(),
  analysisId: z.string().regex(ID).optional(),
  proposalNote: z.string().max(600).optional(),
});

export const conversationMetaSchema = z.object({
  schema: z.literal(CONVERSATION_SCHEMA_VERSION),
  id: z.string().regex(ID),
  title: z.string().min(1).max(120),
  customTitle: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
  messageCount: z.number().int().min(0).max(MAX_CONVERSATION_MESSAGES),
  preview: z.string().max(200),
  vehicleLabel: z.string().max(200).nullable(),
  analysisIds: z.array(z.string().regex(ID)).max(50),
});

const payloadSchema = z.object({
  id: z.string().regex(ID),
  messages: z.array(storedMessageSchema).max(MAX_CONVERSATION_MESSAGES),
  vehicle: specSetSchema.nullable(),
});

export function parseConversationMeta(raw: unknown): ConversationMeta | null {
  const r = conversationMetaSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function parseConversation(meta: unknown, payload: unknown): Conversation | null {
  const m = conversationMetaSchema.safeParse(meta);
  const p = payloadSchema.safeParse(payload);
  if (!m.success || !p.success || m.data.id !== p.data.id) return null;
  return { ...m.data, messages: p.data.messages as StoredMessage[], vehicle: p.data.vehicle as SpecSet | null };
}

export const newConversationId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `c${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

/** Derived list fields, recomputed on every save. */
export function withDerived(c: Omit<Conversation, "messageCount" | "preview" | "schema">): Conversation {
  const lastUser = [...c.messages].reverse().find((m) => m.role === "user");
  return {
    ...c,
    schema: CONVERSATION_SCHEMA_VERSION,
    messageCount: c.messages.length,
    preview: (lastUser?.text ?? "").replace(/\s+/g, " ").slice(0, 200),
    analysisIds: [...new Set(c.analysisIds)].slice(-50),
  };
}

const splitRecord = (c: Conversation) => {
  const { messages, vehicle, ...meta } = c;
  return { meta, payload: { id: c.id, messages, vehicle } };
};

export interface ConversationRepository {
  readonly persistent: boolean;
  list(): Promise<{ items: ConversationMeta[]; unreadable: string[] }>;
  /** Throws StorageError("not_found" | "corrupt"). */
  get(id: string): Promise<Conversation>;
  put(c: Conversation): Promise<void>;
  /** Appends a message to a stored (not currently open) conversation, e.g. a late reply. */
  append(id: string, message: StoredMessage, now?: Date): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

const newestFirst = (a: ConversationMeta, b: ConversationMeta) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);

export class IndexedDbConversations implements ConversationRepository {
  readonly persistent = true;
  constructor(private factory: IDBFactory = globalThis.indexedDB) {}

  private async run<T>(mode: IDBTransactionMode, fn: (meta: IDBObjectStore, payload: IDBObjectStore) => Promise<T> | T): Promise<T> {
    try {
      return await transact(this.factory, [STORES.chats, STORES.chatMessages], mode, (s) => fn(s[STORES.chats], s[STORES.chatMessages]));
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async list() {
    const raw = (await this.run("readonly", (meta) => req(meta.getAll()))) as unknown[];
    const items: ConversationMeta[] = [];
    const unreadable: string[] = [];
    for (const r of raw) {
      const m = parseConversationMeta(r);
      if (m) items.push(m);
      else unreadable.push(String((r as { id?: unknown })?.id ?? "unknown").slice(0, 80));
    }
    return { items: items.sort(newestFirst), unreadable };
  }

  async get(id: string) {
    const [m, p] = await this.run("readonly", (meta, payload) => Promise.all([req(meta.get(id)), req(payload.get(id))]));
    if (!m) throw new StorageError("not_found", "That conversation no longer exists.");
    const c = parseConversation(m, p);
    if (!c) throw new StorageError("corrupt", "This conversation is damaged and can't be opened. Other conversations are not affected.");
    return c;
  }

  async put(c: Conversation) {
    const { meta, payload } = splitRecord(c);
    await this.run("readwrite", (m, p) => {
      m.put(meta);
      p.put(payload);
    });
  }

  async append(id: string, message: StoredMessage, now = new Date()) {
    await this.run("readwrite", async (m, p) => {
      const c = parseConversation(await req(m.get(id)), await req(p.get(id)));
      if (!c) throw new StorageError("not_found", STORAGE_MESSAGES.not_found);
      if (c.messages.length >= MAX_CONVERSATION_MESSAGES || c.messages.some((x) => x.id === message.id)) return;
      const next = withDerived({ ...c, messages: [...c.messages, message], updatedAt: now.toISOString() });
      const { meta, payload } = splitRecord(next);
      m.put(meta);
      p.put(payload);
    });
  }

  async rename(id: string, title: string) {
    await this.run("readwrite", async (m) => {
      const meta = parseConversationMeta(await req(m.get(id)));
      if (!meta) throw new StorageError("not_found", "That conversation no longer exists.");
      m.put({ ...meta, title: title.slice(0, 120), customTitle: true });
    });
  }

  async delete(id: string) {
    await this.run("readwrite", (m, p) => {
      m.delete(id);
      p.delete(id);
    });
  }

  async clear() {
    await this.run("readwrite", (m, p) => {
      m.clear();
      p.clear();
    });
  }
}

export class MemoryConversations implements ConversationRepository {
  readonly persistent: boolean;
  private metas = new Map<string, unknown>();
  private payloads = new Map<string, unknown>();
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

  /** Test hook: store raw (possibly corrupt) records. */
  putRaw(id: string, meta: unknown, payload: unknown) {
    this.metas.set(id, meta);
    this.payloads.set(id, payload);
  }

  async list() {
    const items: ConversationMeta[] = [];
    const unreadable: string[] = [];
    for (const [id, raw] of this.metas) {
      const m = parseConversationMeta(raw);
      if (m) items.push(m);
      else unreadable.push(id);
    }
    return { items: items.sort(newestFirst), unreadable };
  }

  async get(id: string) {
    if (!this.metas.has(id)) throw new StorageError("not_found", "That conversation no longer exists.");
    const c = parseConversation(structuredClone(this.metas.get(id)), structuredClone(this.payloads.get(id)));
    if (!c) throw new StorageError("corrupt", "This conversation is damaged and can't be opened. Other conversations are not affected.");
    return c;
  }

  async put(c: Conversation) {
    this.write();
    const { meta, payload } = splitRecord(structuredClone(c));
    this.metas.set(c.id, meta);
    this.payloads.set(c.id, payload);
  }

  async append(id: string, message: StoredMessage, now = new Date()) {
    const c = await this.get(id);
    if (c.messages.some((x) => x.id === message.id)) return;
    await this.put(withDerived({ ...c, messages: [...c.messages, message], updatedAt: now.toISOString() }));
  }

  async rename(id: string, title: string) {
    this.write();
    const meta = parseConversationMeta(this.metas.get(id));
    if (!meta) throw new StorageError("not_found", "That conversation no longer exists.");
    this.metas.set(id, { ...meta, title: title.slice(0, 120), customTitle: true });
  }

  async delete(id: string) {
    this.metas.delete(id);
    this.payloads.delete(id);
  }

  async clear() {
    this.metas.clear();
    this.payloads.clear();
  }
}

let shared: ConversationRepository | null = null;

export function getConversations(): ConversationRepository {
  if (shared) return shared;
  const idb = typeof globalThis !== "undefined" ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : undefined;
  shared = idb ? new IndexedDbConversations(idb) : new MemoryConversations();
  return shared;
}

export function setConversations(repo: ConversationRepository | null) {
  shared = repo;
}
