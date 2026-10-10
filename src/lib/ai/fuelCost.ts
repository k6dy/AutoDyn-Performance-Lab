// Deterministic fuel-cost arithmetic for the assistant: the model never invents a fuel price or does
// the sums itself. Inputs come from the user's own words (price, distance) and EPA ratings.

const LITRES_PER_GALLON = 3.78541;
const MILES_PER_KM = 0.621371;

export type FuelPrice = { perGallon: number; stated: string };
export type Distance = { miles: number; period: "trip" | "week" | "month" | "year"; stated: string };

const amount = (s: string) => Number(s.replace(/,/g, ""));

/** "$4.20/gal", "4.20 a gallon", "gas is $3.89", "€1.85 per litre" → price per US gallon, or null. */
export function parseFuelPrice(text: string): FuelPrice | null {
  const t = text.toLowerCase();
  const perLitre = /([$€£]?\s?\d{1,2}(?:\.\d{1,3})?)\s*(?:\/|per|a|each)\s*(?:l|litre|liter)s?\b/.exec(t);
  if (perLitre) {
    const v = amount(perLitre[1].replace(/[$€£\s]/g, ""));
    if (v > 0.2 && v < 5) return { perGallon: round(v * LITRES_PER_GALLON, 2), stated: perLitre[0].trim() };
  }
  const perGallon =
    /([$€£]?\s?\d{1,2}(?:\.\d{1,3})?)\s*(?:\/|per|a|each)\s*(?:gal|gallon)s?\b/.exec(t) ??
    /\b(?:gas|fuel|petrol|premium|regular|diesel)(?: prices?)?(?: is| costs?| at| =|:)?\s*(?:about |around |roughly )?\$\s?(\d{1,2}(?:\.\d{1,3})?)\b/.exec(t);
  if (perGallon) {
    const v = amount(perGallon[1].replace(/[$€£\s]/g, ""));
    if (v > 0.5 && v < 15) return { perGallon: v, stated: perGallon[0].trim() };
  }
  return null;
}

/** "1,000 miles", "12,000 miles a year", "40 km a day" → miles and period, or null. */
export function parseDistance(text: string): Distance | null {
  const m = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:k\s*)?(miles?|mi|kilometers?|kilometres?|km)\b(?:\s*(?:a|per|each|\/)\s*(day|week|month|year|yr))?/i.exec(text);
  if (!m) return null;
  let miles = amount(m[1]) * (/k\s*(?:mi|km|kilo)/i.test(m[0]) ? 1000 : 1);
  if (/^k/i.test(m[2])) miles *= MILES_PER_KM;
  let period: Distance["period"] = "trip";
  const unit = (m[3] ?? "").toLowerCase();
  if (unit === "day") {
    miles *= 30;
    period = "month";
  } else if (unit === "week") period = "week";
  else if (unit === "month") period = "month";
  else if (unit === "year" || unit === "yr") period = "year";
  if (!(miles > 0 && miles < 1_000_000)) return null;
  return { miles: round(miles, 0), period, stated: m[0].trim() };
}

function round(n: number, d: number) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type FuelCostLine = { variant: string; combinedMpg: number; miles: number; pricePerGallon: number; gallons: number; costUsd: number; arithmetic: string };

/** miles ÷ combined MPG = gallons; gallons × price = cost — shown step by step. */
export function fuelCost(variant: string, combinedMpg: number, distance: Distance, price: FuelPrice): FuelCostLine {
  const gallons = distance.miles / combinedMpg;
  const cost = gallons * price.perGallon;
  return {
    variant,
    combinedMpg,
    miles: distance.miles,
    pricePerGallon: price.perGallon,
    gallons: round(gallons, 1),
    costUsd: round(cost, 2),
    arithmetic: `${distance.miles.toLocaleString("en-US")} mi ÷ ${combinedMpg} mpg (EPA combined) = ${round(gallons, 1)} gal × ${usd(price.perGallon)}/gal = ${usd(cost)}${distance.period === "trip" ? "" : ` per ${distance.period}`}`,
  };
}

/** The most recent fuel price and distance the user stated in this conversation (latest wins). */
export function statedInputs(userTexts: string[]) {
  let price: FuelPrice | null = null;
  let distance: Distance | null = null;
  for (const t of userTexts) {
    price = parseFuelPrice(t) ?? price;
    distance = parseDistance(t) ?? distance;
  }
  return { price, distance };
}
