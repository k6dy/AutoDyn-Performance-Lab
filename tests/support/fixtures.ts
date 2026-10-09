import { emptySpecValues } from "@/lib/domain/fields";
import type { AnalysisConfig, SpecSet, SpecValues } from "@/lib/domain/types";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { hpToKw, lbToKg, lbftToNm } from "@/lib/units";

const v = <T,>(value: T) => ({ value, provenance: "verified" as const, source: "test fixture" });

/** 2015 Mercedes-Benz C300 (RWD) using the same published figures as the bundled dataset. */
export function c300(): SpecSet {
  const values: SpecValues = emptySpecValues();
  values.powertrain = v("ice");
  values.aspiration = v("forced");
  values.peakPowerKw = v(hpToKw(241));
  values.peakPowerRpm = v(5550);
  values.peakTorqueNm = v(lbftToNm(273));
  values.peakTorqueRpm = v(1300);
  values.drivetrain = v("RWD");
  values.transmission = v("automatic");
  values.gearCount = v(7);
  values.curbMassKg = v(lbToKg(3549));
  return {
    identity: {
      year: 2015,
      make: "Mercedes-Benz",
      model: "C300",
      trim: "C 300",
      source: "dataset",
      sourceDetail: "test fixture",
      bodyStyle: "Sedan",
      fuel: "gas",
      notes: [],
    },
    values,
  };
}

export function ev(): SpecSet {
  const values: SpecValues = emptySpecValues();
  values.powertrain = v("ev");
  values.peakPowerKw = v(258);
  values.peakTorqueNm = v(420);
  values.drivetrain = v("RWD");
  values.curbMassKg = v(1750);
  return {
    identity: { year: 2020, make: "Test", model: "EV", trim: null, source: "custom", sourceDetail: "test", notes: [] },
    values,
  };
}

export function config(stock: SpecSet = c300()): AnalysisConfig {
  return { stock, modified: null, conditions: { ...DEFAULT_CONDITIONS } };
}
