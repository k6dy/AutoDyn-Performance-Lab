// Automatic preservation of completed analyses.
//
// The workspace is linked to at most one saved record (like an open document):
//  1. Re-running an identical configuration only refreshes that record's timestamp.
//  2. Re-running a changed configuration of the same vehicle updates the linked record in place
//     (the UI says so, and Duplicate / Save as keep a separate copy).
//  3. Snapshots made by an older physics engine are never modified implicitly: recalculating one
//     creates a new record and the original is only replaced on explicit request.
//  4. With no linked record, an identical configuration already in history is reused rather than
//     duplicated; otherwise a new record is created.
// Records are never deleted to enforce a limit; storage-full errors surface to the caller.

import type { SpecSet } from "@/lib/domain/types";
import type { AnalysisResult } from "@/lib/physics/analysis";
import { StorageError, type AnalysisRepository } from "@/lib/persistence/repository";
import type { SavedMeta } from "@/lib/persistence/schema";
import { buildRecord, fingerprint, isHistorical, metaOf, updateRecord, vehicleKey } from "@/lib/persistence/snapshot";
import type { UnitSystem } from "@/lib/units";

export type ActiveSaved = Pick<
  SavedMeta,
  "id" | "title" | "customTitle" | "origin" | "sourceId" | "createdAt" | "updatedAt" | "engineVersion" | "fingerprint" | "vehicleKey"
>;

export const toActive = (m: SavedMeta): ActiveSaved => ({
  id: m.id,
  title: m.title,
  customTitle: m.customTitle,
  origin: m.origin,
  sourceId: m.sourceId,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
  engineVersion: m.engineVersion,
  fingerprint: m.fingerprint,
  vehicleKey: m.vehicleKey,
});

export type AutosaveInput = {
  result: AnalysisResult;
  baseline: SpecSet | null;
  units: UnitSystem;
  active: ActiveSaved | null;
  /** Set when this run recalculates a historical snapshot. */
  recalculatedFrom: { id: string; title: string } | null;
  now?: Date;
};

export type AutosaveOutcome = { meta: SavedMeta; action: "linked" | "updated" | "created" };

const recoverable = (e: unknown) => e instanceof StorageError && (e.code === "not_found" || e.code === "corrupt");

export async function autosave(repo: AnalysisRepository, input: AutosaveInput): Promise<AutosaveOutcome> {
  const { result, baseline, units, active, recalculatedFrom } = input;
  const now = input.now ?? new Date();
  const fp = fingerprint(result.config, result.engineVersion);

  if (active && active.fingerprint === fp && !recalculatedFrom) {
    try {
      return { meta: await repo.updateMeta(active.id, { updatedAt: now.toISOString() }), action: "linked" };
    } catch (e) {
      if (!recoverable(e)) throw e;
    }
  }

  if (active && !recalculatedFrom && !isHistorical(active) && active.vehicleKey === vehicleKey(result.identity)) {
    try {
      const existing = await repo.get(active.id);
      const next = updateRecord(existing, result, baseline, now);
      await repo.put(next);
      return { meta: metaOf(next), action: "updated" };
    } catch (e) {
      if (!recoverable(e)) throw e; // a damaged record is left untouched; a new one is created below
    }
  }

  if (!recalculatedFrom) {
    const same = await repo.findByFingerprint(fp);
    if (same) return { meta: await repo.updateMeta(same.id, { updatedAt: now.toISOString() }), action: "linked" };
  }

  const record = buildRecord({
    result,
    baseline,
    units,
    now,
    origin: recalculatedFrom ? "recalculated" : "auto",
    sourceId: recalculatedFrom?.id ?? null,
    title: recalculatedFrom ? `${recalculatedFrom.title} (recalculated)`.slice(0, 120) : undefined,
    customTitle: !!recalculatedFrom,
  });
  await repo.put(record);
  return { meta: metaOf(record), action: "created" };
}

/** Explicit "Save as": a separately named copy of the current analysis. */
export async function saveAs(repo: AnalysisRepository, input: { result: AnalysisResult; baseline: SpecSet | null; units: UnitSystem; title: string; sourceId: string | null }) {
  const record = buildRecord({ ...input, origin: "saved_as", customTitle: true, title: input.title.trim().slice(0, 120) || undefined });
  await repo.put(record);
  return metaOf(record);
}

/** Explicit overwrite of a historical snapshot with its recalculated version. */
export async function replaceOriginal(repo: AnalysisRepository, originalId: string, recalculatedId: string, now = new Date()) {
  const [original, recalc] = await Promise.all([repo.get(originalId), repo.get(recalculatedId)]);
  const next = { ...updateRecord(original, recalc.result, recalc.baseline, now), title: original.title, customTitle: original.customTitle };
  await repo.put(next);
  if (recalculatedId !== originalId) await repo.delete(recalculatedId);
  return metaOf(next);
}
