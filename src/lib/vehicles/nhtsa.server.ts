import "server-only";
import { emptySpecValues } from "@/lib/domain/fields";
import type { Aspiration, Powertrain, SpecSet, TransmissionType } from "@/lib/domain/types";
import { parseDrivetrain } from "@/lib/physics/estimates";
import { hpToKw } from "@/lib/units";

// NHTSA vPIC: vehicle *identification* for any model year. vPIC does not provide complete
// performance specifications, so anything not decoded stays unavailable for manual entry.

const BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";
export const NHTSA_SOURCE = "NHTSA vPIC";

export class ProviderError extends Error {}

async function getJson(url: string) {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000), next: { revalidate: 86400 } });
  } catch {
    throw new ProviderError("NHTSA vPIC did not respond.");
  }
  if (!res.ok) throw new ProviderError(`NHTSA vPIC returned ${res.status}.`);
  try {
    return (await res.json()) as { Results?: Record<string, unknown>[] };
  } catch {
    throw new ProviderError("NHTSA vPIC returned an unreadable response.");
  }
}

export async function nhtsaModels(make: string, year: number): Promise<string[]> {
  const data = await getJson(`${BASE}/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}?format=json`);
  const names = (data.Results ?? []).map((r) => String(r.Model_Name ?? "").trim()).filter(Boolean);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
export const isValidVin = (vin: string) => VIN_RE.test(vin);

function transmissionFrom(style: string, speeds: string): { type: TransmissionType | null; gears: number | null } {
  const s = style.toLowerCase();
  const gears = Number(speeds) || null;
  if (s.includes("cvt") || s.includes("continuously")) return { type: "cvt", gears: null };
  if (s.includes("dual-clutch") || s.includes("dct")) return { type: "dct", gears };
  if (s.includes("manual")) return { type: "manual", gears };
  if (s.includes("automatic")) return { type: gears === 1 ? "direct" : "automatic", gears };
  return { type: null, gears };
}

export async function decodeVin(vin: string): Promise<SpecSet | null> {
  const data = await getJson(`${BASE}/DecodeVinValues/${vin}?format=json`);
  const r = data.Results?.[0];
  if (!r) return null;
  const get = (k: string) => String(r[k] ?? "").trim();
  const year = Number(get("ModelYear")) || null;
  const make = get("Make");
  const model = get("Model");
  if (!make || !model) return null;

  const src = `${NHTSA_SOURCE} VIN decode`;
  const values = emptySpecValues();
  const fuel = get("FuelTypePrimary").toLowerCase();
  const electrification = get("ElectrificationLevel").toLowerCase();
  const powertrain: Powertrain | null = fuel.includes("electric") && !electrification.includes("hybrid") ? "ev" : electrification.includes("hybrid") ? "hybrid" : fuel ? "ice" : null;
  if (powertrain) values.powertrain = { value: powertrain, provenance: "verified", source: src };
  const hp = Number(get("EngineHP"));
  if (hp > 0) values.peakPowerKw = { value: hpToKw(hp), provenance: "verified", source: src, note: "Engine HP as encoded by the manufacturer" };
  const turbo = get("Turbo").toLowerCase();
  if (powertrain === "ev") values.aspiration = { value: "electric", provenance: "verified", source: src };
  else if (turbo === "yes") values.aspiration = { value: "forced" as Aspiration, provenance: "verified", source: src };
  const drive = parseDrivetrain(get("DriveType").replace(/\//g, " "));
  if (drive) values.drivetrain = { value: drive, provenance: "verified", source: src };
  const trans = transmissionFrom(get("TransmissionStyle"), get("TransmissionSpeeds"));
  if (trans.type) values.transmission = { value: trans.type, provenance: "verified", source: src };
  if (trans.gears && trans.type !== "cvt" && trans.type !== "direct") values.gearCount = { value: trans.gears, provenance: "verified", source: src };

  const engine = [get("DisplacementL") && `${Number(get("DisplacementL")).toFixed(1)}L`, get("EngineCylinders") && `${get("EngineCylinders")}-cyl`, get("EngineConfiguration")]
    .filter(Boolean)
    .join(" ");
  const missing = ["curb mass", hp > 0 ? null : "power", "torque"].filter(Boolean);

  return {
    identity: {
      year,
      make: make.replace(/\b\w+/g, (w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())),
      model,
      trim: get("Trim") || get("Series") || null,
      source: "vin",
      sourceDetail: src,
      engineDescription: engine || undefined,
      bodyStyle: get("BodyClass") || undefined,
      fuel: powertrain === "ev" ? "electric" : fuel.includes("diesel") ? "diesel" : fuel ? "gas" : undefined,
      notes: [`NHTSA does not provide ${missing.join(", ")} for this VIN. Enter the missing values to simulate.`],
    },
    values,
  };
}
