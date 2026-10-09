import { describe, expect, it } from "vitest";
import { configSchema } from "@/lib/domain/configSchema";
import type { SpecValues } from "@/lib/domain/types";
import { validateConditions, validateConfig, validateValues } from "@/lib/domain/validation";
import { DEFAULT_CONDITIONS } from "@/lib/domain/types";
import { hpToKw, lbftToNm } from "@/lib/units";
import { c300, config } from "./support/fixtures";

const user = <T,>(value: T) => ({ value, provenance: "user" as const });

function withValues(patch: Partial<SpecValues>) {
  const s = c300();
  s.values = { ...s.values, ...patch };
  return s.values;
}

const errorsFor = (values: SpecValues) => validateValues(values, "stock").filter((i) => i.severity === "error");

describe("input validation", () => {
  it("accepts a valid verified vehicle", () => {
    expect(validateConfig(config()).errors).toBe(0);
  });

  it("rejects negative or zero mass", () => {
    expect(errorsFor(withValues({ curbMassKg: user(-100) }))[0].key).toBe("curbMassKg");
    expect(errorsFor(withValues({ curbMassKg: user(0) })).length).toBeGreaterThan(0);
  });

  it("rejects non-finite numbers", () => {
    expect(errorsFor(withValues({ peakPowerKw: user(Number.NaN) })).length).toBeGreaterThan(0);
    expect(errorsFor(withValues({ dragCoefficient: user(Number.POSITIVE_INFINITY) })).length).toBeGreaterThan(0);
  });

  it("rejects impossible efficiencies", () => {
    expect(errorsFor(withValues({ drivetrainEfficiency: user(1.2) }))[0].key).toBe("drivetrainEfficiency");
    expect(errorsFor(withValues({ drivetrainEfficiency: user(0) })).length).toBeGreaterThan(0);
  });

  it("rejects impossible gear ratios", () => {
    expect(errorsFor(withValues({ gearRatios: user([3.5, 4.0, 1.2]), gearCount: user(3) }))[0].message).toMatch(/decrease/);
    expect(errorsFor(withValues({ gearRatios: user([3.5, -1]), gearCount: user(2) })).length).toBeGreaterThan(0);
    expect(errorsFor(withValues({ gearRatios: user([3.5, 2, 1]), gearCount: user(7) }))[0].message).toMatch(/does not match/);
  });

  it("rejects clearly contradictory power and torque", () => {
    // 400 hp from 50 lb-ft would need ~42,000 rpm.
    const errs = errorsFor(withValues({ peakPowerKw: user(hpToKw(400)), peakTorqueNm: user(lbftToNm(50)) }));
    expect(errs[0].message).toMatch(/contradictory/);
    expect(errs[0].fixes?.length).toBeGreaterThan(0);
  });

  it("rejects torque that would exceed peak power at its own rpm", () => {
    const errs = errorsFor(withValues({ peakTorqueNm: user(lbftToNm(500)), peakTorqueRpm: user(5000) }));
    expect(errs.some((e) => e.key === "peakTorqueRpm")).toBe(true);
  });

  it("flags a stated power peak that needs more torque than available, with a proportional fix in Modified", () => {
    const s = c300();
    const modified = { ...s.values, peakPowerKw: user(hpToKw(340)) };
    const issues = validateValues(modified, "modified", s.identity, s.values).filter((i) => i.severity === "error");
    expect(issues[0].fixes?.[0].label).toMatch(/Scale torque/);
  });

  it("warns (not rejects) for unusual but possible values", () => {
    const issues = validateValues(withValues({ tireMu: user(1.6) }), "stock");
    expect(issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(issues.some((i) => i.severity === "warning" && i.key === "tireMu")).toBe(true);
  });

  it("warns when modified power more than doubles stock", () => {
    const s = c300();
    const modified = { ...s.values, peakPowerKw: user(hpToKw(600)), peakTorqueNm: user(lbftToNm(650)) };
    const issues = validateValues(modified, "modified", s.identity, s.values);
    expect(issues.some((i) => i.severity === "warning" && /double/.test(i.message))).toBe(true);
  });

  it("requires power and mass but not advanced parameters", () => {
    const s = c300();
    s.values.peakPowerKw = { value: null, provenance: "unavailable" };
    const errs = errorsFor(s.values);
    expect(errs.map((e) => e.key)).toEqual(["peakPowerKw"]);
    expect(errorsFor(c300().values)).toHaveLength(0); // no gear ratios, Cd, etc. needed
  });

  it("validates conditions", () => {
    expect(validateConditions({ ...DEFAULT_CONDITIONS, ambientTempC: 90 })[0].severity).toBe("error");
    expect(validateConditions({ ...DEFAULT_CONDITIONS, elevationM: 4000 })[0].severity).toBe("warning");
  });

  it("schema rejects malformed configurations at trust boundaries", () => {
    expect(configSchema.safeParse(config()).success).toBe(true);
    expect(configSchema.safeParse({ ...config(), conditions: { surface: "lava" } }).success).toBe(false);
    const bad = JSON.parse(JSON.stringify(config()));
    bad.stock.values.drivetrain.value = "6WD";
    expect(configSchema.safeParse(bad).success).toBe(false);
  });
});
