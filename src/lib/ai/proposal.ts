// Turns untrusted model output into a bounded list of proposed changes. Nothing here mutates
// application state: proposals are applied only by the client after the user confirms.

import type { ModelOutput } from "@/lib/ai/schema";
import type { AiField, AiUnit, ProposedChange } from "@/lib/ai/types";
import { AI_LIMITS } from "@/lib/ai/types";
import type { Conditions, SpecKey } from "@/lib/domain/types";
import { ftToM, fToC, hpToKw, lbToKg, lbftToNm, M2_PER_FT2, psToKw } from "@/lib/units";

type FieldMap = {
  key: SpecKey | keyof Conditions;
  target?: "conditions";
  units: Partial<Record<AiUnit, (v: number) => number>>;
  /** Unit converter for deltas (differs from absolute only for temperature). */
  deltaUnits?: Partial<Record<AiUnit, (v: number) => number>>;
  options?: readonly string[];
  percentAllowed?: boolean;
  label: string;
};

const id = (v: number) => v;

const FIELD_MAP: Record<AiField, FieldMap> = {
  power: { key: "peakPowerKw", units: { hp: hpToKw, kw: id, ps: psToKw }, percentAllowed: true, label: "Peak power" },
  torque: { key: "peakTorqueNm", units: { lbft: lbftToNm, nm: id }, percentAllowed: true, label: "Peak torque" },
  mass: { key: "curbMassKg", units: { lb: lbToKg, kg: id }, percentAllowed: true, label: "Vehicle weight" },
  payload: { key: "payloadKg", units: { lb: lbToKg, kg: id }, label: "Driver & payload" },
  dragCoefficient: { key: "dragCoefficient", units: { none: id }, percentAllowed: true, label: "Drag coefficient" },
  frontalArea: { key: "frontalAreaM2", units: { m2: id, ft2: (v) => v * M2_PER_FT2 }, percentAllowed: true, label: "Frontal area" },
  drivetrainEfficiency: { key: "drivetrainEfficiency", units: { percent: (v) => v / 100, none: id }, label: "Drivetrain efficiency" },
  tireGrip: { key: "tireMu", units: { none: id }, percentAllowed: true, label: "Tire friction (μ)" },
  finalDrive: { key: "finalDrive", units: { ratio: id, none: id }, percentAllowed: true, label: "Final drive" },
  shiftTime: { key: "shiftTimeS", units: { seconds: id }, label: "Shift time" },
  redline: { key: "redlineRpm", units: { rpm: id }, label: "Redline" },
  drivetrain: { key: "drivetrain", units: {}, options: ["FWD", "RWD", "AWD", "4WD"], label: "Drivetrain" },
  transmission: { key: "transmission", units: {}, options: ["automatic", "manual", "dct", "cvt", "direct"], label: "Transmission" },
  ambientTemperature: {
    key: "ambientTempC", target: "conditions", units: { c: id, f: fToC }, deltaUnits: { c: id, f: (v) => (v * 5) / 9 }, label: "Ambient temperature",
  },
  elevation: { key: "elevationM", target: "conditions", units: { m: id, ft: ftToM }, label: "Elevation" },
  surface: { key: "surface", target: "conditions", units: {}, options: ["dry", "wet", "prepped", "gravel", "snow"], label: "Road surface" },
};

const UNIT_TEXT: Partial<Record<AiUnit, string>> = {
  hp: "hp", kw: "kW", ps: "PS", lbft: "lb·ft", nm: "N·m", lb: "lb", kg: "kg", percent: "%", seconds: "s", rpm: "rpm", c: "°C", f: "°F", m: "m", ft: "ft", m2: "m²", ft2: "ft²",
};

const OPTION_WORDS: Record<string, RegExp> = {
  FWD: /\b(fwd|front[- ]wheel)/i,
  RWD: /\b(rwd|rear[- ]wheel)/i,
  AWD: /\b(awd|all[- ]wheel|quattro|4matic|xdrive|sh-awd)/i,
  "4WD": /\b(4wd|4x4|four[- ]wheel)/i,
  automatic: /\bauto(matic)?\b/i,
  manual: /\bmanual|stick\b/i,
  dct: /\b(dct|dual[- ]clutch|pdk|dsg)\b/i,
  cvt: /\bcvt\b/i,
  direct: /\b(single[- ]speed|direct drive)\b/i,
  dry: /\bdry\b/i,
  wet: /\b(wet|rain)/i,
  prepped: /\b(prep|drag strip|dragstrip)/i,
  gravel: /\bgravel\b/i,
  snow: /\b(snow|ice)\b/i,
};

/** All numeric literals in a text (commas allowed as thousands separators). */
export function numbersIn(text: string): number[] {
  return (text.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, "")));
}

function statedNumber(message: string, value: number) {
  const target = Math.abs(value);
  return numbersIn(message).some((n) => Math.abs(n - target) < 1e-9);
}

const sanitize = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function buildChanges(output: ModelOutput, message: string) {
  const changes: ProposedChange[] = [];
  const rejected: { text: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const [i, c] of output.changes.entries()) {
    const map = FIELD_MAP[c.field];
    const target = map.target ?? c.scenario;
    const text = sanitize(`${map.label}: ${c.operation} ${c.option || c.value} ${c.unit !== "none" ? c.unit : ""}`, 120);
    const slot = `${target}:${map.key}`;
    if (changes.length >= AI_LIMITS.maxChanges) {
      rejected.push({ text, reason: "Too many changes in one request." });
      continue;
    }
    if (seen.has(slot)) {
      rejected.push({ text, reason: "Conflicting instructions for the same parameter." });
      continue;
    }

    let op: ProposedChange["op"];
    let value: number | string;
    let display: string;
    let stated: boolean;

    if (map.options) {
      const option = map.options.find((o) => o.toLowerCase() === c.option.trim().toLowerCase());
      if (!option || c.operation !== "set") {
        rejected.push({ text, reason: "Unsupported option." });
        continue;
      }
      op = "set";
      value = option;
      display = option;
      stated = OPTION_WORDS[option]?.test(message) ?? false;
    } else {
      if (!Number.isFinite(c.value)) {
        rejected.push({ text, reason: "Value is not a finite number." });
        continue;
      }
      if (c.operation === "percent") {
        if (!map.percentAllowed || c.value <= -90 || c.value > 500 || c.value === 0) {
          rejected.push({ text, reason: "Percentage change is not supported for this parameter or is out of range." });
          continue;
        }
        op = "scale";
        value = 1 + c.value / 100;
        display = `${c.value > 0 ? "+" : "−"}${Math.abs(c.value)}%`;
      } else {
        const conv = (c.operation === "change" ? map.deltaUnits ?? map.units : map.units)[c.unit];
        if (!conv) {
          rejected.push({ text, reason: `Unit “${c.unit}” does not apply to ${map.label.toLowerCase()}.` });
          continue;
        }
        if (c.operation === "change" && c.value === 0) {
          rejected.push({ text, reason: "A change of zero has no effect." });
          continue;
        }
        op = c.operation === "change" ? "add" : "set";
        value = conv(c.value);
        const unit = UNIT_TEXT[c.unit] ?? "";
        display = op === "add" ? `${c.value > 0 ? "+" : "−"}${Math.abs(c.value)} ${unit}`.trim() : `${c.value} ${unit}`.trim();
      }
      stated = statedNumber(message, c.value);
    }

    seen.add(slot);
    changes.push({
      id: `c${i}`,
      target,
      key: map.key,
      op,
      value,
      display,
      reason: sanitize(c.reason, 160),
      statedByUser: stated,
    });
  }
  return { changes, rejected };
}

export function sanitizeReply(text: string) {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, AI_LIMITS.maxReplyChars);
}

const FIGURE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(hp|horsepower|bhp|kw|lb[-·\s]?ft|pound[-\s]feet|n[·.\s]?m|lbs?|pounds|kg|mph|km\/h|kph|seconds|secs?|s\b|rpm)/gi;

/**
 * Finds figures with engineering units in a reply that do not appear anywhere in the data AutoDyn
 * sent (context, message, history). Such figures may come from model memory and are flagged.
 */
export function unverifiedFigures(reply: string, knownText: string): string[] {
  const known = numbersIn(knownText);
  const out: string[] = [];
  for (const m of reply.matchAll(FIGURE)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n === 0 || n === 60 || n === 100 || n === 50 || n === 70) continue; // speed-range labels such as 0–60
    const decimals = (m[1].split(".")[1] ?? "").length;
    const tol = 0.5 * Math.pow(10, -decimals) + 1e-9;
    if (!known.some((k) => Math.abs(k - n) <= tol)) out.push(m[0]);
  }
  return Array.from(new Set(out)).slice(0, 6);
}
