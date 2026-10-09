// Normalizes provider records into SpecSets with per-field provenance. Values a provider does
// not supply stay null; the physics resolver estimates them later and labels them as estimates.

import { emptySpecValues } from "@/lib/domain/fields";
import type {
  Aspiration,
  Powertrain,
  SpecSet,
  SpecValue,
  VehicleIdentity,
} from "@/lib/domain/types";
import { estimateFrontalArea, parseDrivetrain, parseTransmission } from "@/lib/physics/estimates";
import { hpToKw, inToM, lbToKg, lbftToNm } from "@/lib/units";

export type DatasetTrim = {
  id: string;
  year: number;
  make: string;
  model: string;
  submodel: string | null;
  trim: string | null;
  description: string | null;
  msrp: number | null;
  engineType: string | null;
  fuel: string | null;
  cylinders: string | null;
  displacementL: number | null;
  hp: number | null;
  hpRpm: number | null;
  torqueLbFt: number | null;
  torqueRpm: number | null;
  drive: string | null;
  transmission: string | null;
  body: string | null;
  doors: number | null;
  curbWeightLb: number | null;
  widthIn: number | null;
  heightIn: number | null;
  wheelbaseIn: number | null;
  lengthIn: number | null;
};

export const DATASET_SOURCE = "CarAPI dataset (manufacturer-published specs)";

function verified<T>(value: T | null | undefined, source: string, note?: string): SpecValue<T> {
  if (value === null || value === undefined) return { value: null, provenance: "unavailable", note: "Not in source data" };
  return { value, provenance: "verified", source, note };
}

export function trimLabel(t: DatasetTrim) {
  return t.description ?? t.trim ?? `Trim ${t.id}`;
}

function powertrainOf(engineType: string | null): Powertrain | null {
  const e = (engineType ?? "").toLowerCase();
  if (!e) return null;
  if (e.startsWith("electric")) return "ev";
  if (e.includes("hybrid")) return "hybrid";
  return "ice";
}

function fuelOf(t: DatasetTrim): VehicleIdentity["fuel"] {
  const e = `${t.engineType ?? ""} ${t.fuel ?? ""}`.toLowerCase();
  if (e.includes("electric") && !e.includes("hybrid")) return "electric";
  if (e.includes("diesel")) return "diesel";
  if (e.includes("gas") || e.includes("unleaded") || e.includes("flex")) return "gas";
  return "other";
}

export function datasetTrimToSpecSet(t: DatasetTrim): SpecSet {
  const src = `${DATASET_SOURCE}, trim #${t.id}`;
  const values = emptySpecValues();
  const powertrain = powertrainOf(t.engineType);
  const desc = t.description ?? "";
  const engineText = desc.match(/\(([^)]+)\)/)?.[1] ?? null;

  values.powertrain = verified(powertrain, src);
  if (powertrain === "ev") {
    values.aspiration = verified<Aspiration>("electric", src);
  } else if (/turbo|supercharg/i.test(desc)) {
    values.aspiration = verified<Aspiration>("forced", src, "Parsed from the trim description");
  } else if (powertrain) {
    values.aspiration = { value: "na", provenance: "estimated", note: "No turbocharger or supercharger listed in the trim description" };
  }

  values.peakPowerKw = verified(t.hp != null ? hpToKw(t.hp) : null, src, "SAE net horsepower rating");
  values.peakTorqueNm = verified(t.torqueLbFt != null ? lbftToNm(t.torqueLbFt) : null, src);
  if (powertrain !== "ev") {
    values.peakPowerRpm = verified(t.hpRpm, src);
    values.peakTorqueRpm = verified(t.torqueRpm, src);
  }
  values.curbMassKg = verified(t.curbWeightLb != null ? lbToKg(t.curbWeightLb) : null, src);
  values.drivetrain = verified(parseDrivetrain(t.drive), src);

  const trans = parseTransmission(t.transmission);
  values.transmission = verified(powertrain === "ev" ? "direct" : trans.type, src, t.transmission ?? undefined);
  if (powertrain !== "ev" && trans.gears && trans.type !== "cvt") values.gearCount = verified(trans.gears, src);

  if (t.widthIn && t.heightIn) {
    const area = estimateFrontalArea(inToM(t.widthIn), inToM(t.heightIn), t.body);
    values.frontalAreaM2 = { value: area.value, provenance: "estimated", note: area.reason };
  }

  const missing: string[] = [];
  if (t.hp == null) missing.push("power");
  if (t.torqueLbFt == null) missing.push("torque");
  if (t.curbWeightLb == null) missing.push("curb weight");
  const missingNote = missing.filter((m) => m !== "curb weight");

  return {
    identity: {
      year: t.year,
      make: t.make,
      model: t.model,
      trim: t.trim,
      source: "dataset",
      sourceDetail: src,
      datasetTrimId: t.id,
      engineDescription: [engineText, t.engineType].filter(Boolean).join(" · ") || undefined,
      bodyStyle: t.body ?? undefined,
      fuel: fuelOf(t),
      notes: missingNote.length ? [`The source dataset does not list ${missingNote.join(" or ")} for this trim.`] : [],
    },
    values,
  };
}

/** A vehicle identified by a provider that has no performance specifications. */
export function identityOnlySpecSet(identity: Omit<VehicleIdentity, "notes"> & { notes?: string[] }): SpecSet {
  return {
    identity: { ...identity, notes: identity.notes ?? [] },
    values: emptySpecValues(),
  };
}

export function customSpecSet(name: string, year: number | null): SpecSet {
  const parts = name.trim().split(/\s+/);
  return identityOnlySpecSet({
    year,
    make: parts[0] || "Custom",
    model: parts.slice(1).join(" ") || "vehicle",
    trim: null,
    source: "custom",
    sourceDetail: "Custom vehicle — all values user-provided",
  });
}

export function vehicleLabel(identity: Pick<VehicleIdentity, "year" | "make" | "model" | "trim">) {
  const base = [identity.year, identity.make, identity.model].filter(Boolean).join(" ");
  const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const model = n(identity.model);
  const trim = identity.trim && !model.includes(n(identity.trim)) ? identity.trim : null;
  if (!trim) return base;
  // "C300" + "C 300 Sport 4MATIC" → keep only the distinguishing words ("Sport 4MATIC").
  const words = trim.split(/\s+/);
  for (let i = 1; i <= words.length; i++) {
    if (n(words.slice(0, i).join("")) === model) {
      const rest = words.slice(i).join(" ");
      return rest ? `${base} ${rest}` : base;
    }
  }
  return `${base} ${trim}`;
}
