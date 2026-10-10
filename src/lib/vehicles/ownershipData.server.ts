import "server-only";
import { z } from "zod";

// Verified, free, official ownership data for the AI assistant (server-side, no keys):
//   - U.S. EPA fueleconomy.gov web services: official fuel-economy ratings per model-year variant
//     (city / highway / combined MPG, fuel type, EPA annual fuel-cost estimate, EV range and kWh/100 mi).
//   - NHTSA recalls API: safety recall campaigns by model year, make and model.
// Neither source has prices, insurance or repair costs, and EPA has no fuel-tank capacity; the
// assistant labels those as general knowledge. Every response is validated, time-bounded, cached
// per server instance and attributed. Failures degrade to "unavailable" — never to invented data.

export const EPA_SOURCE = "U.S. EPA fueleconomy.gov";
export const RECALL_SOURCE = "NHTSA recalls database";
const EPA = "https://www.fueleconomy.gov/ws/rest";
const NHTSA = "https://api.nhtsa.gov/recalls/recallsByVehicle";

export type JsonFetcher = (url: string, signal: AbortSignal) => Promise<unknown>;

export const defaultFetcher: JsonFetcher = async (url, signal) => {
  const res = await fetch(url, { signal, headers: { Accept: "application/json" }, next: { revalidate: 43200 } });
  // NHTSA answers 400 with a JSON body ({"Count":0}) when a model name matches nothing.
  if (!res.ok && res.status !== 400 && res.status !== 404) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!res.ok && !text.trim().startsWith("{")) throw new Error(`HTTP ${res.status}`);
  return text.trim() ? JSON.parse(text) : null; // EPA answers "null" when nothing matches
};

export type VehicleQuery = { year: number | null; make: string; model: string };

// ---- Cache (per server instance; both sources change rarely) ------------------------------------

const TTL = 12 * 3600_000;
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, load: () => Promise<T>, keep: (v: T) => boolean): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const value = await load();
  if (keep(value)) {
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}
/** Test hook. */
export function clearOwnershipCache() {
  cache.clear();
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const yearOk = (y: number | null): y is number => !!y && y >= 1984 && y <= new Date().getFullYear() + 1;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ---- EPA fuel economy ------------------------------------------------------------------------

const menuItem = z.object({ text: z.string().max(200), value: z.string().max(200) });
const menuSchema = z.object({ menuItem: z.union([menuItem, z.array(menuItem)]) }).nullable();
const vehicleSchema = z.object({
  id: z.coerce.string(),
  year: z.coerce.string(),
  make: z.string(),
  model: z.string(),
  city08: z.coerce.string().optional(),
  highway08: z.coerce.string().optional(),
  comb08: z.coerce.string().optional(),
  fuelType: z.string().optional(),
  fuelCost08: z.coerce.string().optional(),
  range: z.coerce.string().optional(),
  combE: z.coerce.string().optional(),
  drive: z.string().optional(),
  trany: z.string().optional(),
  atvType: z.string().optional(),
});

const menu = (raw: unknown) => {
  const m = menuSchema.safeParse(raw);
  if (!m.success || !m.data) return [];
  return Array.isArray(m.data.menuItem) ? m.data.menuItem : [m.data.menuItem];
};

export type FuelEconomyVariant = {
  label: string;
  cityMpg: number | null;
  highwayMpg: number | null;
  combinedMpg: number | null;
  fuel: string | null;
  /** EPA's own estimate (15,000 mi/yr, 55% city, EPA's current fuel-price assumption). */
  epaAnnualFuelCostUsd: number | null;
  electricRangeMiles: number | null;
  kwhPer100Miles: number | null;
  drive: string | null;
  transmission: string | null;
  url: string;
};

export type FuelEconomyResult =
  | { status: "found"; source: string; query: string; variants: FuelEconomyVariant[]; totalVariants: number }
  | { status: "needs_year" | "not_found" | "unavailable"; source: string; query: string; note: string };

/**
 * Official EPA ratings for a model year, make and model. Matches the model by its words ("F-Type
 * R" → "F-Type R AWD Coupe"), returns up to `maxVariants` engine/transmission variants and how many
 * exist in total.
 */
export async function lookupFuelEconomy(q: VehicleQuery, opts: { fetcher?: JsonFetcher; signal?: AbortSignal; maxVariants?: number } = {}): Promise<FuelEconomyResult> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const query = `${q.year ?? ""} ${q.make} ${q.model}`.trim();
  if (!yearOk(q.year)) return { status: "needs_year", source: EPA_SOURCE, query, note: "EPA ratings are per model year; the model year is needed." };
  const year = q.year;
  const signal = AbortSignal.any([AbortSignal.timeout(4500), ...(opts.signal ? [opts.signal] : [])]);
  const get = (path: string) => fetcher(`${EPA}${path}`, signal);
  return cached(
    `epa:${year}:${compact(q.make)}:${compact(q.model)}`,
    async (): Promise<FuelEconomyResult> => {
      try {
        const makes = menu(await get(`/vehicle/menu/make?year=${year}`));
        const make = makes.find((m) => compact(m.value) === compact(q.make))?.value;
        if (!make) return { status: "not_found", source: EPA_SOURCE, query, note: `EPA lists no ${q.make} vehicles for ${year}.` };
        const want = tokens(q.model);
        const models = menu(await get(`/vehicle/menu/model?year=${year}&make=${encodeURIComponent(make)}`))
          .map((m) => ({ name: m.value, words: tokens(m.value) }))
          .filter((m) => want.every((w) => m.words.includes(w)))
          .sort((a, b) => a.words.length - b.words.length)
          .slice(0, 3);
        if (!models.length) return { status: "not_found", source: EPA_SOURCE, query, note: `EPA has no ${year} ${make} model matching “${q.model}”.` };
        const options = await Promise.all(
          models.map(async (m) => menu(await get(`/vehicle/menu/options?year=${year}&make=${encodeURIComponent(make)}&model=${encodeURIComponent(m.name)}`)).map((o) => ({ model: m.name, option: o.text, id: o.value }))),
        );
        const total = options.reduce((n, o) => n + o.length, 0);
        // Round-robin across matched models so coupe and convertible (or AWD and RWD) both show.
        const picked: { model: string; option: string; id: string }[] = [];
        for (let i = 0; picked.length < (opts.maxVariants ?? 4) && options.some((o) => o[i]); i++) for (const o of options) if (o[i] && picked.length < (opts.maxVariants ?? 4)) picked.push(o[i]);
        if (!/^\d+$/.test(picked[0]?.id ?? "")) return { status: "not_found", source: EPA_SOURCE, query, note: `EPA lists no variants for ${year} ${make} ${q.model}.` };
        const variants = await Promise.all(
          picked.map(async (p): Promise<FuelEconomyVariant | null> => {
            if (!/^\d+$/.test(p.id)) return null;
            const v = vehicleSchema.safeParse(await get(`/vehicle/${p.id}`));
            if (!v.success) return null;
            const ev = v.data.atvType === "EV";
            return {
              label: `${year} ${make} ${p.model} — ${p.option}`.slice(0, 160),
              cityMpg: ev ? null : num(v.data.city08),
              highwayMpg: ev ? null : num(v.data.highway08),
              combinedMpg: ev ? null : num(v.data.comb08),
              fuel: v.data.fuelType ?? null,
              epaAnnualFuelCostUsd: num(v.data.fuelCost08),
              electricRangeMiles: num(v.data.range),
              kwhPer100Miles: num(v.data.combE),
              drive: v.data.drive ?? null,
              transmission: v.data.trany ?? null,
              url: `https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=${p.id}`,
            };
          }),
        );
        const found = variants.filter((v): v is FuelEconomyVariant => !!v);
        if (!found.length) return { status: "unavailable", source: EPA_SOURCE, query, note: "EPA vehicle records could not be read." };
        return { status: "found", source: EPA_SOURCE, query, variants: found, totalVariants: total };
      } catch {
        return { status: "unavailable", source: EPA_SOURCE, query, note: "fueleconomy.gov did not respond in time." };
      }
    },
    (r) => r.status !== "unavailable",
  );
}

// ---- NHTSA recalls ---------------------------------------------------------------------------

const recallSchema = z.object({
  Count: z.number().int().nonnegative(),
  results: z
    .array(
      z.object({
        NHTSACampaignNumber: z.string().max(40),
        ReportReceivedDate: z.string().max(40).optional(),
        Component: z.string().max(300).optional(),
        Summary: z.string().max(4000).optional(),
      }),
    )
    .default([]),
});

export type RecallResult =
  | { status: "found"; source: string; query: string; count: number; recalls: { campaign: string; reported: string | null; component: string | null; summary: string }[]; url: string }
  | { status: "none" | "needs_year" | "unavailable"; source: string; query: string; note: string };

/** Recall campaigns for a model year; retries without trim words (NHTSA lists "F-Type", not "F-Type R"). */
export async function lookupRecalls(q: VehicleQuery, opts: { fetcher?: JsonFetcher; signal?: AbortSignal; max?: number } = {}): Promise<RecallResult> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const query = `${q.year ?? ""} ${q.make} ${q.model}`.trim();
  if (!yearOk(q.year)) return { status: "needs_year", source: RECALL_SOURCE, query, note: "Recalls are listed per model year; the model year is needed." };
  const year = q.year;
  const signal = AbortSignal.any([AbortSignal.timeout(4500), ...(opts.signal ? [opts.signal] : [])]);
  const names = [...new Set([q.model, q.model.split(/\s+/)[0]])];
  return cached(
    `nhtsa:${year}:${compact(q.make)}:${compact(q.model)}`,
    async (): Promise<RecallResult> => {
      try {
        for (const name of names) {
          const url = `${NHTSA}?make=${encodeURIComponent(q.make)}&model=${encodeURIComponent(name)}&modelYear=${year}`;
          const r = recallSchema.safeParse(await fetcher(url, signal));
          if (!r.success) return { status: "unavailable", source: RECALL_SOURCE, query, note: "The NHTSA response could not be read." };
          if (r.data.Count > 0) {
            return {
              status: "found",
              source: RECALL_SOURCE,
              query: `${year} ${q.make} ${name}`,
              count: r.data.Count,
              recalls: r.data.results.slice(0, opts.max ?? 5).map((x) => ({
                campaign: x.NHTSACampaignNumber,
                reported: x.ReportReceivedDate ?? null,
                component: x.Component ?? null,
                summary: (x.Summary ?? "").replace(/\s+/g, " ").slice(0, 260),
              })),
              url: `https://www.nhtsa.gov/recalls?year=${year}&make=${encodeURIComponent(q.make)}&model=${encodeURIComponent(name)}`,
            };
          }
        }
        return { status: "none", source: RECALL_SOURCE, query, note: `NHTSA lists no recalls under “${names.join("” or “")}” for ${year} ${q.make}. The model may be listed under a different name.` };
      } catch {
        return { status: "unavailable", source: RECALL_SOURCE, query, note: "The NHTSA recalls service did not respond in time." };
      }
    },
    (r) => r.status !== "unavailable",
  );
}
