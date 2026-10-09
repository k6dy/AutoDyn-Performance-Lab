// Input validation shared by Manual Setup, the AI proposal pipeline and the /api/simulate route.
// Errors block simulation; warnings flag unusual-but-possible values and require confirmation.

import {
  ASPIRATION_OPTIONS,
  DRIVETRAIN_OPTIONS,
  NUMERIC_FIELDS,
  POWERTRAIN_OPTIONS,
  SPEC_LABEL,
  SURFACE_OPTIONS,
  TRANSMISSION_OPTIONS,
} from "@/lib/domain/fields";
import { effectiveValues } from "@/lib/domain/scenario";
import type {
  AnalysisConfig,
  Conditions,
  NumericSpecKey,
  ScenarioId,
  SpecKey,
  SpecValues,
  VehicleIdentity,
} from "@/lib/domain/types";
import { NUMERIC_KEYS } from "@/lib/domain/types";
import { resolveInputs } from "@/lib/physics/resolve";
import { radSToRpm, rpmToRadS } from "@/lib/units";

export type Fix = { key: SpecKey; value: number; label: string };

export type Issue = {
  id: string;
  severity: "error" | "warning";
  scenario: ScenarioId | "conditions";
  key?: SpecKey | keyof Conditions;
  message: string;
  fixes?: Fix[];
};

const ENUMS: Partial<Record<SpecKey, readonly string[]>> = {
  powertrain: POWERTRAIN_OPTIONS.map((o) => o.value),
  aspiration: ASPIRATION_OPTIONS.map((o) => o.value),
  drivetrain: DRIVETRAIN_OPTIONS.map((o) => o.value),
  transmission: TRANSMISSION_OPTIONS.map((o) => o.value),
};

export function validateValues(
  values: SpecValues,
  scenario: ScenarioId,
  identity?: Pick<VehicleIdentity, "bodyStyle" | "fuel">,
  stockValues?: SpecValues,
): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], key: SpecKey | undefined, message: string, fixes?: Fix[]) =>
    issues.push({ id: `${scenario}:${key ?? "general"}:${issues.length}`, severity, scenario, key, message, fixes });

  for (const [key, allowed] of Object.entries(ENUMS) as [SpecKey, readonly string[]][]) {
    const v = values[key]?.value;
    if (v !== null && v !== undefined && !allowed.includes(v as string)) add("error", key, `${SPEC_LABEL[key]} has an unsupported value.`);
  }

  for (const key of NUMERIC_KEYS) {
    const def = NUMERIC_FIELDS[key];
    const v = values[key]?.value;
    if (v === null || v === undefined) {
      if (def.required) add("error", key, `${def.label} is required. AutoDyn does not estimate it — enter a value.`);
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      add("error", key, `${def.label} must be a finite number.`);
      continue;
    }
    if (v < def.hard[0] || v > def.hard[1]) {
      add("error", key, `${def.label} is outside the physically meaningful range.`);
      continue;
    }
    if (def.integer && !Number.isInteger(v)) add("error", key, `${def.label} must be a whole number.`);
    if (v < def.typical[0] || v > def.typical[1]) add("warning", key, `${def.label} is unusual for a road vehicle. Confirm it is intended.`);
  }

  const ratios = values.gearRatios?.value;
  if (ratios) {
    if (!Array.isArray(ratios) || ratios.length === 0 || ratios.length > 12 || ratios.some((r) => typeof r !== "number" || !Number.isFinite(r) || r <= 0 || r > 20)) {
      add("error", "gearRatios", "Gear ratios must be 1–12 positive numbers.");
    } else {
      if (ratios.some((r, i) => i > 0 && r >= ratios[i - 1])) add("error", "gearRatios", "Gear ratios must decrease from first to top gear.");
      const count = values.gearCount?.value;
      if (count && values.transmission.value !== "cvt" && count !== ratios.length)
        add("error", "gearRatios", `Gear count (${count}) does not match the ${ratios.length} ratios entered.`);
      if (ratios[0] > 8 || ratios[ratios.length - 1] < 0.3) add("warning", "gearRatios", "Gear ratios are unusual. Confirm they are intended.");
    }
  }

  if (values.powertrain.value === "ev" && values.gearCount.value && values.gearCount.value > 1)
    add("warning", "gearCount", "Multi-speed electric transmissions are modeled as a single reduction gear.");

  // Cross-field physics consistency, checked on resolved values.
  if (issues.some((i) => i.severity === "error")) return issues;
  const conditions: Conditions = { ambientTempC: 25, elevationM: 0, surface: "dry", rollout: false };
  const resolved = resolveInputs(values, conditions, identity);
  if (!resolved.ok) return issues;
  const { curve } = resolved.inputs;
  const P = curve.peakPowerW;
  const T = curve.peakTorqueNm;
  const torqueLabel = SPEC_LABEL.peakTorqueNm.toLowerCase();
  const scaledFix = (): Fix[] => {
    if (scenario !== "modified" || !stockValues?.peakTorqueNm.value || !stockValues.peakPowerKw.value) return [];
    const scaled = Math.ceil(stockValues.peakTorqueNm.value * ((values.peakPowerKw.value ?? 0) / stockValues.peakPowerKw.value));
    return scaled > T ? [{ key: "peakTorqueNm", value: scaled, label: "Scale torque by the same percentage as power" }] : [];
  };

  const rpmNeeded = radSToRpm(P / T);
  if (rpmNeeded > curve.redlineRpm * 1.02) {
    const needed = Math.ceil(P / rpmToRadS(curve.peakPowerRpm > 0 ? Math.min(curve.peakPowerRpm, curve.redlineRpm) : curve.redlineRpm));
    add(
      "error",
      "peakTorqueNm",
      `Power and torque are contradictory: producing the stated peak power with this ${torqueLabel} would need ${Math.round(rpmNeeded).toLocaleString()} rpm, above the ${Math.round(curve.redlineRpm).toLocaleString()} rpm limit.`,
      [...scaledFix(), { key: "peakTorqueNm", value: needed, label: "Raise peak torque to the minimum consistent value" }],
    );
    return issues;
  }

  if (values.powertrain.value !== "ev") {
    const prGiven = values.peakPowerRpm.value != null && values.peakPowerRpm.provenance !== "estimated";
    if (prGiven) {
      const neededAtPeak = P / rpmToRadS(curve.peakPowerRpm);
      if (neededAtPeak > T * 1.02) {
        add(
          "error",
          "peakTorqueNm",
          `At the ${Math.round(curve.peakPowerRpm).toLocaleString()} rpm power peak, the stated power requires more torque than the stated peak torque.`,
          [
            ...scaledFix(),
            { key: "peakTorqueNm", value: Math.ceil(neededAtPeak), label: "Raise peak torque to the minimum consistent value" },
            { key: "peakPowerRpm", value: Math.min(Math.ceil(rpmNeeded / 50) * 50, curve.redlineRpm), label: "Move the power peak to a higher rpm" },
          ],
        );
      }
    }
    if (values.peakTorqueRpm.value != null && T * rpmToRadS(curve.peakTorqueRpm) > P * 1.03) {
      add("error", "peakTorqueRpm", "Peak torque at the stated rpm would produce more than the stated peak power. Lower the torque-peak speed or check the values.");
    }
    if (curve.peakPowerRpm > curve.redlineRpm) add("error", "peakPowerRpm", "Power peak speed cannot exceed the redline.");
    if (curve.peakTorqueRpm > curve.peakPowerRpm) add("error", "peakTorqueRpm", "Torque peak speed cannot exceed the power peak speed.");
  }

  const massKg = resolved.inputs.massKg;
  if (P / massKg > 750) add("warning", "peakPowerKw", "Power-to-weight ratio exceeds most production hypercars. Confirm the values are intended.");

  if (scenario === "modified" && stockValues) {
    const sp = stockValues.peakPowerKw.value;
    const mp = values.peakPowerKw.value;
    if (sp && mp && mp > sp * 2)
      add("warning", "peakPowerKw", "Modified power is more than double stock. AutoDyn does not assess whether engine or drivetrain hardware could survive this.");
    const sm = stockValues.curbMassKg.value;
    const mm = values.curbMassKg.value;
    if (sm && mm && mm < sm * 0.75) add("warning", "curbMassKg", "Modified mass is more than 25% below stock. Confirm this is achievable.");
  }

  return issues;
}

export function validateConditions(c: Conditions): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], key: keyof Conditions, message: string) =>
    issues.push({ id: `conditions:${key}`, severity, scenario: "conditions", key, message });
  if (!Number.isFinite(c.ambientTempC) || c.ambientTempC < -60 || c.ambientTempC > 60) add("error", "ambientTempC", "Temperature must be between −60 °C and 60 °C.");
  else if (c.ambientTempC < -30 || c.ambientTempC > 45) add("warning", "ambientTempC", "Ambient temperature is extreme. Confirm it is intended.");
  if (!Number.isFinite(c.elevationM) || c.elevationM < -500 || c.elevationM > 6000) add("error", "elevationM", "Elevation must be between −500 m and 6,000 m.");
  else if (c.elevationM > 3500) add("warning", "elevationM", "Elevation is unusually high. Confirm it is intended.");
  if (!SURFACE_OPTIONS.some((s) => s.value === c.surface)) add("error", "surface", "Unsupported road surface.");
  return issues;
}

export function validateConfig(config: AnalysisConfig) {
  const issues: Issue[] = [];
  if (!config.stock) {
    return {
      issues: [{ id: "vehicle", severity: "error", scenario: "stock", message: "Choose or define a vehicle first." } as Issue],
      errors: 1,
      warnings: 0,
    };
  }
  const stock = config.stock.values;
  issues.push(...validateValues(stock, "stock", config.stock.identity));
  if (config.modified) {
    issues.push(...validateValues(effectiveValues(config, "modified")!, "modified", config.stock.identity, stock));
  }
  issues.push(...validateConditions(config.conditions));
  return {
    issues,
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
}

export function numericKeyLabel(key: NumericSpecKey) {
  return NUMERIC_FIELDS[key].label;
}
