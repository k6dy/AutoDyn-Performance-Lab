// Vehicle specifications for the provider turn. A vehicle named in the message is resolved against
// AutoDyn's dataset BEFORE Gemini answers — with the same matcher and spec-set builder the proposal,
// Review Changes, Manual Setup and the physics engine use — so the reply and the review panel always
// describe the same records. Gemini receives the values as structured data; it never supplies them.

import { displaySpec } from "@/lib/ai/context";
import type { SpecKey, SpecSet } from "@/lib/domain/types";
import { candidateLabel, matchVehicle, type VehicleQuery } from "@/lib/vehicles/match";
import { datasetTrimToSpecSet, vehicleLabel, type DatasetTrim } from "@/lib/vehicles/normalize";
import type { UnitSystem } from "@/lib/units";

export type SpecFact = { field: string; value: string; provenance: "verified" | "estimated" | "unavailable" };

export type VehicleFacts = {
  /** What the user named ("2015 Mercedes-Benz C300 4MATIC"). */
  requested: string;
  /** matched: one dataset specification · variants: several differing specifications (the user chooses) · not_in_dataset: none. */
  status: "matched" | "variants" | "not_in_dataset";
  source: string;
  vehicles: { label: string; specs: SpecFact[] }[];
  note: string;
};

const FACT_KEYS: SpecKey[] = ["peakPowerKw", "peakPowerRpm", "peakTorqueNm", "peakTorqueRpm", "curbMassKg", "drivetrain", "transmission", "gearCount"];
const CORE: SpecKey[] = ["peakPowerKw", "peakTorqueNm", "curbMassKg"];
/** Designators that distinguish trims sharing a model name ("C300 4MATIC" vs "C300"). */
const TRIM_HINTS = /\b(4matic\+?|xdrive|quattro|4motion|sh-awd|awd|4wd|rwd|fwd|all[- ]wheel|rear[- ]wheel|front[- ]wheel|luxury|sport|premium|limited|touring)\b/gi;
const SOURCE = "AutoDyn specification dataset (CarAPI, manufacturer-published) — the records AutoDyn loads for review and simulation";

const LABELS: Partial<Record<SpecKey, string>> = {
  peakPowerKw: "Peak power",
  peakPowerRpm: "Power peak speed",
  peakTorqueNm: "Peak torque",
  peakTorqueRpm: "Torque peak speed",
  curbMassKg: "Curb weight",
  drivetrain: "Drivetrain",
  transmission: "Transmission",
  gearCount: "Gears",
};
const displayLabel = (k: SpecKey) => LABELS[k] ?? k;

/** Known values with their provenance; a missing core value (power, torque, weight) is listed as unavailable. */
export function specFacts(set: SpecSet, units: UnitSystem): SpecFact[] {
  return FACT_KEYS.filter((k) => set.values[k].value != null || CORE.includes(k)).map((k) => {
    const v = set.values[k];
    if (v.value == null) return { field: displayLabel(k), value: "not in the dataset", provenance: "unavailable" as const };
    return { field: displayLabel(k), value: displaySpec(k, set.values, units), provenance: v.provenance === "verified" ? ("verified" as const) : ("estimated" as const) };
  });
}

function match(trims: DatasetTrim[], q: VehicleQuery, message: string) {
  const first = matchVehicle(trims, q);
  if (first.status !== "multiple" || !first.candidates.length) return first;
  // Narrow with a trim designator the user wrote ("4MATIC", "AWD").
  for (const hint of new Set((message.match(TRIM_HINTS) ?? []).map((h) => h.toLowerCase()))) {
    const narrowed = matchVehicle(trims, { ...q, trim: hint });
    if (narrowed.status === "unique") return narrowed;
  }
  return first;
}

/**
 * Dataset facts for the vehicles a message names (at most two). Vehicles already loaded in the
 * workspace are skipped — their specifications travel in CONTEXT.stockSpecs.
 */
export function vehicleFacts(
  targets: VehicleQuery[],
  opts: { trims: DatasetTrim[]; message: string; units: UnitSystem; loaded?: { year: number | null; make: string; model: string } | null; specSetFor?: (t: DatasetTrim) => SpecSet },
): VehicleFacts[] {
  const out: VehicleFacts[] = [];
  const build = opts.specSetFor ?? datasetTrimToSpecSet;
  const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const q of targets.slice(0, 2)) {
    if (!q.make || !q.model) continue;
    const l = opts.loaded;
    if (l && norm(l.make) === norm(q.make) && norm(l.model) === norm(q.model) && (!q.year || q.year === l.year)) continue;
    const requested = [q.year, q.make, q.model].filter(Boolean).join(" ");
    const m = match(opts.trims, q, opts.message);
    if (m.status === "unique") {
      const set = build(m.trim);
      const missing = CORE.filter((k) => set.values[k].value == null).map((k) => displayLabel(k).toLowerCase());
      out.push({
        requested,
        status: "matched",
        source: SOURCE,
        vehicles: [{ label: vehicleLabel(set.identity), specs: specFacts(set, opts.units) }],
        note: missing.length
          ? `The dataset does not list ${missing.join(" or ")} for this trim; say so and never supply a figure.`
          : "Power, torque and curb weight are in AutoDyn's dataset (verified). Never say they are missing or unavailable.",
      });
    } else if (m.status === "multiple" && m.candidates.length) {
      out.push({
        requested,
        status: "variants",
        source: SOURCE,
        vehicles: m.candidates.slice(0, 4).map((t) => {
          const set = build(t);
          return { label: candidateLabel(t), specs: specFacts(set, opts.units).filter((f) => ["Peak power", "Peak torque", "Curb weight", "Drivetrain"].includes(f.field)) };
        }),
        note: "Several dataset versions differ; AutoDyn asks the user to choose. Values shared by all versions may be quoted; don't present one version's differing value as the user's.",
      });
    } else {
      out.push({
        requested,
        status: "not_in_dataset",
        source: SOURCE,
        vehicles: [],
        note: `${m.status === "none" ? m.reason : m.question} Peak power, torque and curb weight are unavailable in AutoDyn's dataset — don't supply them from memory; the user can enter them in Manual Setup.`,
      });
    }
  }
  return out;
}

const SPEC_WORD = /\b(?:horsepower|hp|power|torque|weight|curb weight|specs?|specifications?|figures)\b/i;
const MISSING =
  /\b(?:not (?:present|available|listed|included|found|provided|in)|missing|unavailable|(?:don't|doesn't|do not|does not|didn't) (?:have|include|list|contain|show)|no (?:verified |exact |published )?(?:data|figures?|specs?|specifications?|values?)|(?:isn't|aren't|is not|are not) (?:in|available|listed|present))\b/i;
const DATA_WORD = /\b(?:dataset|data|verified|autodyn|database|records?)\b/i;

/**
 * Sentences claiming verified specifications are missing when AutoDyn's dataset has them (the
 * reply must not contradict the review panel). EPA statements are left alone: EPA never lists
 * engine output, and saying so is correct.
 */
export function contradictsKnownSpecs(sentence: string) {
  return SPEC_WORD.test(sentence) && MISSING.test(sentence) && DATA_WORD.test(sentence) && !/\bEPA\b|fueleconomy/i.test(sentence);
}

/** True when every named vehicle that was looked up has power, torque and weight in the dataset. */
export function specsKnown(facts: VehicleFacts[], proposalSpecs: SpecSet | null): boolean {
  const fromFacts = facts.length > 0 && facts.every((f) => f.status === "matched" && f.vehicles[0].specs.filter((s) => ["Peak power", "Peak torque", "Curb weight"].includes(s.field)).every((s) => s.provenance !== "unavailable"));
  const fromProposal = !!proposalSpecs && CORE.every((k) => proposalSpecs.values[k].value != null);
  return fromFacts || (facts.every((f) => f.status !== "not_in_dataset") && fromProposal);
}
