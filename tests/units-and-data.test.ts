import { describe, expect, it } from "vitest";
import {
  cToF,
  fToC,
  fromDisplay,
  hpToKw,
  kgToLb,
  kwToHp,
  lbToKg,
  lbftToNm,
  mphToMs,
  msToMph,
  nmToLbft,
  tireSizeToRadiusM,
  toDisplay,
} from "@/lib/units";
import { datasetMakes, datasetModels, datasetTrim, datasetTrims, datasetYears, allDatasetTrims } from "@/lib/vehicles/dataset.server";
import { matchVehicle } from "@/lib/vehicles/match";
import { datasetTrimToSpecSet, vehicleLabel } from "@/lib/vehicles/normalize";
import { parseDrivetrain, parseTransmission } from "@/lib/physics/estimates";

describe("unit conversions", () => {
  it("round-trips and matches reference values", () => {
    expect(hpToKw(1)).toBeCloseTo(0.7457, 4);
    expect(kwToHp(hpToKw(241))).toBeCloseTo(241, 10);
    expect(lbftToNm(1)).toBeCloseTo(1.35582, 5);
    expect(nmToLbft(lbftToNm(273))).toBeCloseTo(273, 10);
    expect(lbToKg(1)).toBeCloseTo(0.45359237, 8);
    expect(kgToLb(lbToKg(3549))).toBeCloseTo(3549, 10);
    expect(mphToMs(60)).toBeCloseTo(26.8224, 4);
    expect(msToMph(mphToMs(60))).toBeCloseTo(60, 10);
    expect(fToC(212)).toBeCloseTo(100, 10);
    expect(cToF(-40)).toBeCloseTo(-40, 10);
  });

  it("converts display units in both systems", () => {
    expect(toDisplay("power", hpToKw(300), "imperial")).toBeCloseTo(300, 8);
    expect(toDisplay("power", 200, "metric")).toBe(200);
    expect(fromDisplay("mass", 3000, "imperial")).toBeCloseTo(1360.78, 2);
    expect(toDisplay("fraction", 0.85, "metric")).toBeCloseTo(85, 10);
    expect(fromDisplay("temperature", 77, "imperial")).toBeCloseTo(25, 10);
  });

  it("parses tire sizes into rolling radius", () => {
    // 17 in rim → 215.9 mm + 101.25 mm sidewall = 317.15 mm unloaded, ×0.97 loaded
    expect(tireSizeToRadiusM("225/45R17")).toBeCloseTo(0.3076, 3);
    expect(tireSizeToRadiusM("P245/40 ZR18")).toBeGreaterThan(0.3);
    expect(tireSizeToRadiusM("banana")).toBeNull();
  });

  it("parses transmission and drivetrain descriptions", () => {
    expect(parseTransmission("7-speed shiftable automatic")).toEqual({ type: "automatic", gears: 7 });
    expect(parseTransmission("6-speed manual")).toEqual({ type: "manual", gears: 6 });
    expect(parseTransmission("7-speed automated manual")).toEqual({ type: "dct", gears: 7 });
    expect(parseTransmission("continuously variable-speed automatic").type).toBe("cvt");
    expect(parseTransmission("1-speed direct drive")).toEqual({ type: "direct", gears: 1 });
    expect(parseDrivetrain("all wheel drive")).toBe("AWD");
    expect(parseDrivetrain("front wheel drive")).toBe("FWD");
  });
});

describe("vehicle dataset", () => {
  it("covers 2015–2020 and returns valid dependent options", () => {
    expect(datasetYears()).toEqual([2020, 2019, 2018, 2017, 2016, 2015]);
    expect(datasetMakes(2015)).toContain("Mercedes-Benz");
    expect(datasetModels(2015, "Mercedes-Benz")).toContain("C300");
    const trims = datasetTrims(2015, "Mercedes-Benz", "C300");
    expect(trims.length).toBeGreaterThanOrEqual(4);
    expect(trims.every((t) => t.year === 2015 && t.model === "C300")).toBe(true);
  });

  it("returns nothing for impossible combinations", () => {
    expect(datasetMakes(1999)).toEqual([]);
    expect(datasetModels(2015, "Tesla").includes("Mustang")).toBe(false);
    expect(datasetTrims(2015, "Mercedes-Benz", "F-150")).toEqual([]);
    expect(datasetTrims(2010, "Mercedes-Benz", "C300")).toEqual([]);
  });

  it("normalizes a trim with provenance and SI units", () => {
    const rwd = datasetTrims(2015, "Mercedes-Benz", "C300").find((t) => t.drive === "rear wheel drive")!;
    const s = datasetTrimToSpecSet(rwd);
    expect(s.values.peakPowerKw).toMatchObject({ provenance: "verified" });
    expect(kwToHp(s.values.peakPowerKw.value!)).toBeCloseTo(241, 6);
    expect(s.values.aspiration.value).toBe("forced");
    expect(s.values.drivetrain.value).toBe("RWD");
    expect(s.values.transmission.value).toBe("automatic");
    expect(s.values.gearCount.value).toBe(7);
    expect(s.values.frontalAreaM2.provenance).toBe("estimated");
    expect(s.values.dragCoefficient).toMatchObject({ value: null }); // estimated later, never fabricated as verified
    expect(s.identity.sourceDetail).toMatch(/CarAPI/);
    expect(vehicleLabel(s.identity)).toMatch(/2015 Mercedes-Benz C300/);
  });

  it("builds readable labels without repeating the model in the trim", () => {
    const id = { year: 2015, make: "Mercedes-Benz", model: "C300" };
    expect(vehicleLabel({ ...id, trim: "C 300" })).toBe("2015 Mercedes-Benz C300");
    expect(vehicleLabel({ ...id, trim: "C 300 Sport 4MATIC" })).toBe("2015 Mercedes-Benz C300 Sport 4MATIC");
    expect(vehicleLabel({ year: 2018, make: "Toyota", model: "Camry", trim: "XSE" })).toBe("2018 Toyota Camry XSE");
  });

  it("keeps missing specifications unavailable instead of inventing them", () => {
    const tesla = allDatasetTrims().find((t) => t.make === "Tesla" && t.hp == null)!;
    const s = datasetTrimToSpecSet(tesla);
    expect(s.values.peakPowerKw).toMatchObject({ value: null, provenance: "unavailable" });
    expect(s.values.powertrain.value).toBe("ev");
    expect(s.identity.notes.join(" ")).toMatch(/does not list power/);
    expect(datasetTrim("999999999")).toBeNull();
  });
});

describe("vehicle matching for the assistant", () => {
  const trims = allDatasetTrims();
  it("matches a uniquely specified vehicle", () => {
    const r = matchVehicle(trims, { year: 2015, make: "Mercedes", model: "C 300", trim: "4MATIC" });
    expect(r.status).toBe("unique");
    if (r.status === "unique") expect(r.trim.drive).toBe("all wheel drive");
  });

  it("asks which version when trims differ in specification", () => {
    const r = matchVehicle(trims, { year: 2015, make: "Mercedes-Benz", model: "C300" });
    expect(r.status).toBe("multiple");
    if (r.status === "multiple") expect(r.candidates.length).toBeGreaterThan(1);
  });

  it("asks for the year when missing", () => {
    const r = matchVehicle(trims, { make: "Mercedes-Benz", model: "C300" });
    expect(r.status).toBe("multiple");
    if (r.status === "multiple") expect(r.question).toMatch(/year/);
  });

  it("reports unknown vehicles honestly", () => {
    expect(matchVehicle(trims, { year: 2015, make: "Yugo", model: "GV" }).status).toBe("none");
    const r = matchVehicle(trims, { year: 2010, make: "Mercedes-Benz", model: "C300" });
    expect(r.status).toBe("none");
    if (r.status === "none") expect(r.reason).toMatch(/not 2010/);
  });
});
