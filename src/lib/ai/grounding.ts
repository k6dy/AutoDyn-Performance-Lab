// Verified data for one assistant request: official lookups (EPA ratings and U.S. variant lists,
// NHTSA recalls) chosen by the question's facet, and AutoDyn's own fuel-cost arithmetic. Everything
// here is deterministic; the model only explains it. No extra AI calls.

import { fuelCost, statedInputs, type FuelCostLine } from "@/lib/ai/fuelCost";
import type { AspectId } from "@/lib/ai/lexicon";
import type { AssistantRequest } from "@/lib/ai/schema";
import type { Source } from "@/lib/ai/types";
import { pinnedVehicles, type Topic } from "@/lib/ai/topic";
import type { FuelEconomyResult, RecallResult, VariantListResult, VehicleQuery } from "@/lib/vehicles/ownershipData.server";

export type OwnershipSources = {
  fuelEconomy: (q: VehicleQuery, signal: AbortSignal) => Promise<FuelEconomyResult>;
  recalls: (q: VehicleQuery, signal: AbortSignal) => Promise<RecallResult>;
  variants?: (q: VehicleQuery, signal: AbortSignal) => Promise<VariantListResult>;
};


export type FuelCostData =
  | { kind: "fuel_cost"; status: "calculated"; method: string; lines: (FuelCostLine & { appliesTo: string[] })[]; inputs: { price: string; distance: string; mpgSource: string } }
  | { kind: "fuel_cost"; status: "needs_input"; missing: string[]; note: string };

export type Grounding = FuelEconomyResult | RecallResult | VariantListResult | FuelCostData;

const FUEL_ASPECTS: (AspectId | null)[] = ["fuel_economy", "fuel_range", "ev_range"];
const SPEC_ASPECTS: (AspectId | null)[] = ["specs", "performance", "towing", "practicality"];
const MY_VEHICLE = /\b(?:my|this|the current|our)\s+(?:\w+\s+){0,2}?(?:car|vehicle|ride|truck|build|setup)\b/i;
const AVAILABILITY = /\b(?:awd|xdrive|4matic|quattro|4wd|rwd|fwd|2wd|all[- ]wheel|rear[- ]wheel|manual|stick|automatic|dct|transmission|gearbox|drivetrain|available|offered|come (?:in|with)|versions?|variants?|trims?|which engines?)\b/i;
const COST_WORDS = /\$|\b(?:cost|costs|spend|spending|price|budget|money|how much|per (?:month|year|week)|a (?:month|year|week))\b/i;
const PREFER = /\b(awd|xdrive|4matic|quattro|4wd|4x4|rwd|fwd|2wd|coupe|convertible|sedan|wagon|hatchback|cabriolet|manual|stick|automatic|auto|dct|dual[- ]clutch)\b/gi;
const USER_MPG = /\b(\d{1,2}(?:\.\d)?)\s*mpg\b/i;

/** Drivetrain and body words the user used, latest last ("the AWD coupe") — they pick EPA variants. */
function preferences(userTexts: string[]) {
  const words = userTexts.flatMap((t) => [...t.matchAll(PREFER)].map((m) => m[1].toLowerCase()));
  const awd = ["awd", "xdrive", "4matic", "quattro", "4wd", "4x4"];
  const lastDrive = [...words].reverse().find((w) => awd.includes(w) || ["rwd", "fwd", "2wd"].includes(w));
  const lastBody = [...words].reverse().find((w) => ["coupe", "convertible", "sedan", "wagon", "hatchback", "cabriolet"].includes(w));
  const lastTrans = [...words].reverse().find((w) => ["manual", "stick", "automatic", "auto", "dct", "dual-clutch", "dual clutch"].includes(w));
  const trans = lastTrans ? (["manual", "stick"].includes(lastTrans) ? "manual" : "automatic") : undefined;
  return [lastDrive, lastBody, trans].filter((w): w is string => !!w);
}

/** Vehicles to look up: those the conversation pins down, else the Manual Setup vehicle when the user means it. */
export function lookupTargets(topic: Topic | null, context: AssistantRequest["context"], message: string, userTexts: string[] = [message]): VehicleQuery[] {
  const prefer = preferences(userTexts);
  const pinned = pinnedVehicles(topic);
  const v = context.vehicle;
  const loaded = v ? { year: v.year, make: v.make, model: v.model } : null;
  if (pinned.length) {
    // "my C300": the model matches the loaded vehicle, which supplies the year.
    return pinned.map((p) => ({ ...(loaded && !p.year && loaded.make === p.make && loaded.model.toLowerCase() === p.model.toLowerCase() ? loaded : p), prefer }));
  }
  if (loaded && (MY_VEHICLE.test(message) || topic?.models.some((m) => m.toLowerCase() === loaded.model.toLowerCase()))) return [{ ...loaded, prefer }];
  return [];
}

/** AutoDyn's fuel-cost arithmetic from EPA (or user-stated) MPG and the user's own price and distance. */
function fuelCostFor(ratings: FuelEconomyResult[], userTexts: string[]): FuelCostData {
  const { price, distance } = statedInputs(userTexts);
  const userMpg = [...userTexts].reverse().map((t) => USER_MPG.exec(t)).find(Boolean);
  const variants = ratings.flatMap((r) => (r.status === "found" ? r.variants : [])).filter((v) => v.combinedMpg);
  const missing = [
    !price && "the fuel price the user pays (per gallon or litre) — ask for it; never assume one",
    !distance && "the distance (per trip, month or year)",
    !variants.length && !userMpg && "a model year and engine for the EPA rating (or the user's own MPG)",
  ].filter((m): m is string => !!m);
  if (missing.length) return { kind: "fuel_cost", status: "needs_input", missing, note: "Do not estimate a fuel cost until these are known; you may show the method: miles ÷ MPG × price per gallon." };
  const seen = new Set<number>();
  const lines = variants.length
    ? variants
        .filter((v) => !seen.has(v.combinedMpg!) && seen.add(v.combinedMpg!))
        .slice(0, 3)
        // Variants sharing a rating are named explicitly (a coupe's figure is never passed off as a convertible's).
        .map((v) => ({ ...fuelCost(v.label, v.combinedMpg!, distance!, price!), appliesTo: variants.filter((x) => x.combinedMpg === v.combinedMpg).map((x) => x.label) }))
    : [{ ...fuelCost("the user's stated fuel economy", Number(userMpg![1]), distance!, price!), appliesTo: [] }];
  return {
    kind: "fuel_cost",
    status: "calculated",
    method: "miles ÷ combined MPG = gallons; gallons × price per gallon = cost (AutoDyn arithmetic)",
    lines,
    inputs: { price: price!.stated, distance: distance!.stated, mpgSource: variants.length ? "EPA combined rating of each listed variant" : "user-stated MPG" },
  };
}

/** Fetches what the question's facet calls for. Failures become notes, never invented data. */
export async function gatherGrounding(opts: {
  aspect: AspectId | null;
  topic: Topic | null;
  context: AssistantRequest["context"];
  message: string;
  userTexts: string[];
  sources?: OwnershipSources;
}): Promise<Grounding[]> {
  const { aspect, message, userTexts, sources } = opts;
  const targets = lookupTargets(opts.topic, opts.context, message, userTexts);
  const signal = AbortSignal.timeout(5000);
  const out: Grounding[] = [];
  const settle = <T,>(p: Promise<T>) => p.catch(() => null);
  if (sources && targets.length) {
    if (FUEL_ASPECTS.includes(aspect)) out.push(...((await Promise.all(targets.map((t) => settle(sources.fuelEconomy(t, signal))))).filter(Boolean) as FuelEconomyResult[]));
    else if (aspect === "recalls" || aspect === "safety") out.push(...((await Promise.all(targets.map((t) => settle(sources.recalls(t, signal))))).filter(Boolean) as RecallResult[]));
    else if (sources.variants && (SPEC_ASPECTS.includes(aspect) || AVAILABILITY.test(message) || opts.topic?.comparing) && targets.some((t) => t.year))
      out.push(...((await Promise.all(targets.filter((t) => t.year).map((t) => settle(sources.variants!(t, signal))))).filter(Boolean) as VariantListResult[]));
  }
  if (FUEL_ASPECTS.includes(aspect) && COST_WORDS.test(message)) out.push(fuelCostFor(out.filter((g): g is FuelEconomyResult => "variants" in g), userTexts));
  return out;
}

const date = (iso: string) => iso.slice(0, 10);

/** Links for the verified values used in this answer (official pages, retrieval date). */
export function sourcesOf(data: Grounding[]): Source[] {
  const out: Source[] = [];
  for (const d of data) {
    if (!("status" in d) || d.status !== "found") continue;
    if ("variants" in d) for (const v of d.variants.slice(0, 3)) out.push({ label: `EPA fuel economy — ${v.label}`, url: v.url, retrieved: date(d.retrieved) });
    else if ("models" in d) out.push({ label: `EPA-listed U.S. versions — ${d.query}`, url: d.url, retrieved: date(d.retrieved) });
    else if ("recalls" in d) out.push({ label: `NHTSA recalls — ${d.query} (${d.count})`, url: d.url, retrieved: date(d.retrieved) });
  }
  return out.slice(0, 5);
}
