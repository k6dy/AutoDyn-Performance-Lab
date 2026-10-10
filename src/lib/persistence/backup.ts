// JSON backup of saved analyses (export / import). Imported files are data only: parsed with
// JSON.parse, validated field by field, and never executed or rendered as HTML.

import { validateConfig } from "@/lib/domain/validation";
import { ID_PATTERN, parseSaved, type SavedAnalysis, type SavedMeta } from "@/lib/persistence/schema";
import { APP_VERSION, fingerprint, newRecordId, summarize, vehicleKey } from "@/lib/persistence/snapshot";
import { ENGINE_VERSION } from "@/lib/physics/analysis";

export const BACKUP_FORMAT = "autodyn-analyses";
export const BACKUP_FORMAT_VERSION = 1;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_ANALYSES = 1000;

export type Backup = {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  exportedAt: string;
  app: string;
  engineVersion: string;
  count: number;
  note: string;
  analyses: SavedAnalysis[];
};

export function buildBackup(records: SavedAnalysis[], now = new Date()): string {
  const backup: Backup = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    app: `AutoDyn Performance Lab ${APP_VERSION}`,
    engineVersion: ENGINE_VERSION,
    count: records.length,
    note: "Saved AutoDyn analyses. All numbers are SI units. Results are theoretical model outputs, not measured performance.",
    analyses: records,
  };
  return JSON.stringify(backup);
}

export type ImportPlan = {
  /** Records ready to write (ids already de-conflicted). */
  accepted: SavedAnalysis[];
  /** Records already present unchanged (same id and content). */
  skipped: number;
  /** Records given a new id because theirs was taken. */
  reassigned: number;
  rejected: { index: number; title: string | null; reason: string }[];
};

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/**
 * Validates a backup file's text against the existing history. Throws ImportError when the
 * file as a whole is unusable; individual bad records are listed in `rejected`.
 */
export function planImport(text: string, existing: SavedMeta[], now = new Date()): ImportPlan {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError(`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ImportError("The file isn't valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ImportError("The file isn't an AutoDyn analyses backup.");
  const d = data as Record<string, unknown>;
  if (d.format !== BACKUP_FORMAT) {
    if (d.app === "AutoDyn Performance Lab" && "engineVersion" in d) {
      throw new ImportError("This is an AutoDyn report export, not a saved-analyses backup. Use “Export backup” in Saved Analyses to create an importable file.");
    }
    throw new ImportError("The file isn't an AutoDyn analyses backup.");
  }
  if (typeof d.formatVersion !== "number" || !Number.isInteger(d.formatVersion)) throw new ImportError("The backup has no valid format version.");
  if (d.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new ImportError(`The backup was made by a newer AutoDyn (format ${d.formatVersion}); this version reads format ${BACKUP_FORMAT_VERSION}.`);
  }
  if (!Array.isArray(d.analyses)) throw new ImportError("The backup contains no analyses list.");
  if (d.analyses.length > MAX_IMPORT_ANALYSES) throw new ImportError(`The backup holds more than ${MAX_IMPORT_ANALYSES} analyses.`);

  const byId = new Map(existing.map((m) => [m.id, m]));
  const taken = new Set(existing.map((m) => m.id));
  const plan: ImportPlan = { accepted: [], skipped: 0, reassigned: 0, rejected: [] };

  d.analyses.forEach((raw, index) => {
    const title = raw && typeof raw === "object" && typeof (raw as { title?: unknown }).title === "string" ? String((raw as { title: string }).title).slice(0, 120) : null;
    const parsed = parseSaved(raw);
    if (!parsed.ok) {
      plan.rejected.push({ index, title, reason: `Invalid or incomplete record (${parsed.error}).` });
      return;
    }
    const r = parsed.record;
    if (r.result.engineVersion !== r.engineVersion) {
      plan.rejected.push({ index, title, reason: "Its results don't match its recorded engine version." });
      return;
    }
    if (!r.result.config.stock || validateConfig(r.result.config).errors > 0) {
      plan.rejected.push({ index, title, reason: "It contains physically invalid inputs." });
      return;
    }
    // Derived fields are recomputed, never trusted from the file.
    const record: SavedAnalysis = {
      ...r,
      fingerprint: fingerprint(r.result.config, r.engineVersion),
      vehicleKey: vehicleKey(r.result.identity),
      summary: summarize(r.result),
      origin: "import",
    };
    const current = byId.get(record.id);
    if (current && current.fingerprint === record.fingerprint && current.updatedAt === record.updatedAt) {
      plan.skipped += 1;
      return;
    }
    if (taken.has(record.id) || !ID_PATTERN.test(record.id)) {
      record.id = newRecordId();
      record.sourceId = null;
      plan.reassigned += 1;
    }
    if (record.sourceId && !ID_PATTERN.test(record.sourceId)) record.sourceId = null;
    record.updatedAt = record.updatedAt > now.toISOString() ? now.toISOString() : record.updatedAt;
    taken.add(record.id);
    plan.accepted.push(record);
  });
  return plan;
}
