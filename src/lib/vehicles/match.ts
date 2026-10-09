// Resolves a free-text vehicle description against the dataset. Pure and deterministic, so the AI
// assistant can only ever *select* real records — it never supplies specifications.

import type { DatasetTrim } from "@/lib/vehicles/normalize";
import { trimLabel } from "@/lib/vehicles/normalize";

export type VehicleQuery = { year?: number | null; make?: string | null; model?: string | null; trim?: string | null };

export type MatchResult =
  | { status: "unique"; trim: DatasetTrim; sharedWith: number }
  | { status: "multiple"; candidates: DatasetTrim[]; question: string }
  | { status: "none"; make: string | null; reason: string };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const MAKE_ALIASES: Record<string, string> = {
  chevy: "chevrolet",
  vw: "volkswagen",
  mercedes: "mercedesbenz",
  benz: "mercedesbenz",
  merc: "mercedesbenz",
  mb: "mercedesbenz",
  alfa: "alfaromeo",
  rangerover: "landrover",
  landy: "landrover",
  caddy: "cadillac",
  beemer: "bmw",
  bimmer: "bmw",
};

function signature(t: DatasetTrim) {
  return [t.hp, t.torqueLbFt, t.drive, t.transmission, t.curbWeightLb ? Math.round(t.curbWeightLb / 25) : null].join("|");
}

export function candidateLabel(t: DatasetTrim) {
  return `${t.year} ${t.make} ${t.model} — ${trimLabel(t)}`;
}

export function matchVehicle(trims: DatasetTrim[], q: VehicleQuery): MatchResult {
  const makeKey = MAKE_ALIASES[norm(q.make)] ?? norm(q.make);
  if (!makeKey) return { status: "none", make: null, reason: "No make was given." };
  const ofMake = trims.filter((t) => norm(t.make) === makeKey);
  if (!ofMake.length) return { status: "none", make: q.make ?? null, reason: `“${q.make}” is not in AutoDyn's specification dataset.` };
  const make = ofMake[0].make;

  const modelKey = norm(q.model);
  if (!modelKey) return { status: "none", make, reason: "No model was given." };
  const haystack = norm(`${q.model ?? ""} ${q.trim ?? ""}`);

  const scored = ofMake
    .map((t) => {
      const dm = norm(t.model);
      const score = dm === modelKey ? 3 : dm.length >= 2 && haystack.includes(dm) ? 2 : modelKey.length >= 3 && dm.startsWith(modelKey) ? 1 : 0;
      return { t, score };
    })
    .filter((x) => x.score > 0);
  if (!scored.length) return { status: "none", make, reason: `No ${make} model matching “${q.model}” in the dataset (2015–2020 model years).` };
  const best = Math.max(...scored.map((x) => x.score));
  let pool = scored.filter((x) => x.score === best).map((x) => x.t);

  if (q.year) {
    const byYear = pool.filter((t) => t.year === q.year);
    if (!byYear.length) {
      const years = Array.from(new Set(pool.map((t) => t.year))).sort();
      return { status: "none", make, reason: `The dataset has ${make} ${pool[0].model} for ${years.join(", ")} but not ${q.year}.` };
    }
    pool = byYear;
  } else if (new Set(pool.map((t) => t.year)).size > 1) {
    const years = Array.from(new Set(pool.map((t) => t.year))).sort();
    return { status: "multiple", candidates: [], question: `Which model year? The dataset has ${years.join(", ")}.` };
  }

  if (new Set(pool.map((t) => norm(t.model))).size > 1) {
    const models = Array.from(new Set(pool.map((t) => t.model)));
    return {
      status: "multiple",
      candidates: pool.slice(0, 10),
      question: `Which model do you mean: ${models.slice(0, 6).join(", ")}?`,
    };
  }

  const trimKey = norm(q.trim);
  if (trimKey) {
    const byTrim = pool.filter((t) => norm(t.trim).includes(trimKey) || norm(t.description).includes(trimKey));
    if (byTrim.length) pool = byTrim;
  }

  const groups = new Map<string, DatasetTrim[]>();
  for (const t of pool) groups.set(signature(t), [...(groups.get(signature(t)) ?? []), t]);
  if (groups.size === 1) {
    const sorted = [...pool].sort((a, b) => (a.msrp ?? 0) - (b.msrp ?? 0));
    return { status: "unique", trim: sorted[0], sharedWith: pool.length - 1 };
  }
  const reps = Array.from(groups.values()).map((g) => [...g].sort((a, b) => (a.msrp ?? 0) - (b.msrp ?? 0))[0]);
  return {
    status: "multiple",
    candidates: reps.slice(0, 10),
    question: `Which version? ${pool[0].year} ${pool[0].make} ${pool[0].model} has ${groups.size} distinct powertrain/drivetrain specifications.`,
  };
}
