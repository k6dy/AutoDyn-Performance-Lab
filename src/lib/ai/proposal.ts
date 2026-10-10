// Turns untrusted model output into a bounded list of proposed changes. Nothing here mutates
// application state: proposals are applied only by the client after the user confirms.

import type { ModelOutput } from "@/lib/ai/schema";
import type { AiField, AiUnit, ProposedChange } from "@/lib/ai/types";
import { AI_LIMITS } from "@/lib/ai/types";
import type { Conditions, ConstraintKey, SpecKey } from "@/lib/domain/types";
import { ftToM, fToC, hpToKw, kphToMs, lbToKg, lbftToNm, M2_PER_FT2, mphToMs, psToKw } from "@/lib/units";

type FieldMap = {
  key: SpecKey | keyof Conditions | ConstraintKey;
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
  claimedZeroTo60: { key: "claimedZeroTo60S", units: { seconds: id }, label: "Claimed 0–60 mph" },
  claimedTopSpeed: { key: "claimedTopSpeedMs", units: { mph: mphToMs, kmh: kphToMs }, label: "Claimed top speed" },
};

const UNIT_TEXT: Partial<Record<AiUnit, string>> = {
  mph: "mph", kmh: "km/h", hp: "hp", kw: "kW", ps: "PS", lbft: "lb·ft", nm: "N·m", lb: "lb", kg: "kg", percent: "%", seconds: "s", rpm: "rpm", c: "°C", f: "°F", m: "m", ft: "ft", m2: "m²", ft2: "ft²",
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

/** A trailing heading, or a table header and separator, left without content after a cut. */
const DANGLING = /\n+(?:#{1,6}\s[^\n]*|[^\n]*\|[^\n]*\n\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?)\s*$/;

/**
 * Normalizes model text while keeping its line structure (paragraphs, lists, tables). Replies are
 * rendered as React text, never HTML; tag-like markup is still removed as defense in depth, while
 * comparisons such as "boost < 10 psi" survive.
 */
export function cleanReply(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Shortens text at the last paragraph, line or sentence end within `max` (never mid-word). */
export function clipText(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const cut = text.slice(0, max);
  const para = cut.lastIndexOf("\n\n");
  const line = cut.lastIndexOf("\n");
  const sentence = Math.max(...[". ", "! ", "? ", ".\n"].map((p) => cut.lastIndexOf(p)));
  let out: string;
  if (para >= max * 0.5) out = cut.slice(0, para);
  else if (line >= max * 0.6) out = cut.slice(0, line);
  else if (sentence >= max * 0.5) out = cut.slice(0, sentence + 1);
  else out = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.8))}…`;
  // A heading or table header left without its content is dropped.
  out = out.replace(DANGLING, "").trimEnd();
  return { text: out, clipped: true };
}

export function sanitizeReply(text: string) {
  return clipText(cleanReply(text), AI_LIMITS.maxReplyChars).text;
}

/**
 * Recovers the reply from structured output that stopped at the output-token limit: the JSON is
 * incomplete, but the "reply" string up to the cut is usable. Returns null when there is none.
 */
export function salvageReply(raw: string): string | null {
  const start = /"reply"\s*:\s*"/.exec(raw);
  if (!start) return null;
  const ESC: Record<string, string> = { n: "\n", t: "\t", r: "", b: "", f: "", '"': '"', "\\": "\\", "/": "/" };
  let out = "";
  for (let i = start.index + start[0].length; i < raw.length; ) {
    const ch = raw[i];
    if (ch === '"') break;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = raw.slice(i + 2, i + 6);
        if (!/^[0-9a-f]{4}$/i.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ESC[next] ?? next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out || null;
}

/** The completed part of a cut-off reply: up to its last finished sentence or line. */
export function completedPart(text: string): string {
  const t = cleanReply(text);
  let done = t;
  if (!/[.!?:)]$/.test(t)) {
    const sentence = Math.max(...[". ", "! ", "? "].map((p) => t.lastIndexOf(p)));
    const end = Math.max(sentence + 1, t.lastIndexOf("\n"));
    done = end > 0 ? t.slice(0, end) : `${t}…`;
  }
  return clipText(done.trimEnd(), AI_LIMITS.maxReplyChars).text.replace(DANGLING, "").trimEnd();
}

const FIGURE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(hp|horsepower|bhp|kwh|kw|lb[-·\s]?ft|pound[-\s]feet|n[·.\s]?m|lbs?|pounds|kg|mpge?|mph|km\/h|kph|seconds|secs?|s\b|rpm)/gi;
const PRICE = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?k\b)?/gi;

/**
 * Finds figures with engineering units (including MPG and kWh) and prices in a reply that do not
 * appear anywhere in the data AutoDyn sent (context, message, history, verified external data).
 * Such figures may come from model memory and are flagged.
 */
export function unverifiedFigures(reply: string, knownText: string): string[] {
  const known = numbersIn(knownText);
  const out: string[] = [];
  const isKnown = (raw: string, scale = 1) => {
    const n = Number(raw.replace(/,/g, "")) * scale;
    const decimals = scale === 1 ? (raw.split(".")[1] ?? "").length : 0;
    const tol = 0.5 * Math.pow(10, -decimals) + 1e-9;
    return known.some((k) => Math.abs(k - n) <= tol);
  };
  for (const m of reply.matchAll(FIGURE)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n === 0 || n === 60 || n === 100 || n === 50 || n === 70) continue; // speed-range labels such as 0–60
    if (!isKnown(m[1])) out.push(m[0]);
  }
  for (const m of reply.matchAll(PRICE)) if (!isKnown(m[1], m[2] ? 1000 : 1)) out.push(m[0].replace(/\s+/g, ""));
  return Array.from(new Set(out)).slice(0, 6);
}
