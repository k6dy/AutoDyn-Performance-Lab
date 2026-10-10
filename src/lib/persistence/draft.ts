// The working configuration (draft) is autosaved separately from completed analyses, in
// localStorage. On return it is offered (Continue / Start fresh), never applied automatically, and
// it is validated and sanitized first so stale or impossible values (e.g. a 1 lb curb weight saved
// by an older build) cannot come back.

import { configSchema, specSetSchema } from "@/lib/domain/configSchema";
import { sanitizeRestored } from "@/lib/domain/sanitize";
import { MAX_MESSAGE_TEXT } from "@/lib/persistence/conversations";
import type { AnalysisConfig, SpecSet } from "@/lib/domain/types";
import type { UnitSystem } from "@/lib/units";

export const DRAFT_KEY = "autodyn:draft:v4";
export const PREFS_KEY = "autodyn:prefs";
/** Keys written by earlier builds; read once for migration, then removed. */
const LEGACY_KEYS = ["autodyn:v3", "autodyn:v2", "autodyn:v1", "autodyn"];

export type DraftMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: number; notices?: string[] };

export type Draft = {
  version: 4;
  savedAt: number;
  config: AnalysisConfig;
  baseline: SpecSet | null;
  /** Saved analysis the workspace was linked to. */
  activeId: string | null;
  messages: DraftMessage[];
};

export type DraftOffer = Draft & {
  /** Values that were physically invalid and were reset during validation. */
  fixes: string[];
};

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function cleanMessages(raw: unknown): DraftMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.text === "string")
    .map((m) => ({
      id: String(m.id).slice(0, 80),
      role: m.role as "user" | "assistant",
      text: String(m.text).slice(0, MAX_MESSAGE_TEXT),
      createdAt: Number(m.createdAt) || 0,
      notices: Array.isArray(m.notices) ? m.notices.map((n: unknown) => String(n).slice(0, 400)).slice(0, 10) : undefined,
    }))
    .slice(-40);
}

/** Validates a stored draft (current or legacy layout). Returns null for anything unusable. */
export function parseDraft(raw: unknown): DraftOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.version !== 4 && d.version !== 3) return null;
  const config = configSchema.safeParse(d.config);
  if (!config.success || !config.data.stock) return null;
  const baselineParsed = d.baseline ? specSetSchema.safeParse(d.baseline) : null;
  let baseline = baselineParsed?.success ? (baselineParsed.data as SpecSet) : null;
  const cfg = config.data as AnalysisConfig;
  // A baseline from another vehicle must never supply this vehicle's values.
  if (baseline && (baseline.identity.make !== cfg.stock!.identity.make || baseline.identity.model !== cfg.stock!.identity.model || baseline.identity.year !== cfg.stock!.identity.year)) {
    baseline = null;
  }
  const clean = sanitizeRestored(cfg, baseline);
  return {
    version: 4,
    savedAt: Number(d.savedAt) || 0,
    config: clean.config,
    baseline,
    activeId: typeof d.activeId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(d.activeId) ? d.activeId : null,
    messages: cleanMessages(d.messages),
    fixes: clean.fixed,
  };
}

export function readDraft(): DraftOffer | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(DRAFT_KEY);
    if (raw) {
      const draft = parseDraft(JSON.parse(raw));
      if (!draft) s.removeItem(DRAFT_KEY); // corrupted: discard rather than retry every visit
      return draft;
    }
    // One-time migration from the previous build's session key.
    for (const key of LEGACY_KEYS) {
      const legacy = s.getItem(key);
      if (legacy == null) continue;
      s.removeItem(key);
      const draft = key === "autodyn:v3" ? parseDraft(JSON.parse(legacy)) : null;
      if (draft) return draft;
    }
  } catch {
    try {
      s.removeItem(DRAFT_KEY);
    } catch {
      // ignore
    }
  }
  return null;
}

export function writeDraft(draft: Omit<Draft, "version" | "savedAt">, now = Date.now()): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(DRAFT_KEY, JSON.stringify({ version: 4, savedAt: now, ...draft, messages: draft.messages.slice(-40) }));
    return true;
  } catch {
    return false; // quota / private mode: the session itself still works
  }
}

export function clearDraft() {
  try {
    storage()?.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}

export function readUnitsPref(): UnitSystem | null {
  const s = storage();
  try {
    const raw = s?.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.units === "metric" || p?.units === "imperial") return p.units;
    }
    const legacy = s?.getItem("autodyn:v3");
    if (legacy) {
      const u = JSON.parse(legacy)?.units;
      if (u === "metric" || u === "imperial") return u;
    }
  } catch {
    // ignore
  }
  return null;
}

export function writeUnitsPref(units: UnitSystem) {
  try {
    storage()?.setItem(PREFS_KEY, JSON.stringify({ units }));
  } catch {
    // ignore
  }
}
