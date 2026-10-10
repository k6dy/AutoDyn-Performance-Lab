// Conversation titles generated locally from the user's own words and the vehicle in context —
// never by an extra AI request.

import { MAKES, MODELS } from "@/lib/ai/lexicon";
import { normalize } from "@/lib/ai/relevance";
import { aspectLabel, type Topic } from "@/lib/ai/topic";

export const DEFAULT_TITLE = "New Conversation";
const MAX = 60;

const TOPICS: [RegExp, string][] = [
  [/\bturbo\w*\b.*\bsupercharg|\bsupercharg\w*\b.*\bturbo/, "Turbo vs Supercharger"],
  [/\bhorsepower\b.*\btorque\b|\btorque\b.*\bhorsepower\b/, "Horsepower vs Torque"],
  [/\b(?:awd|4wd)\b.*\b(?:rwd|fwd)\b|\b(?:rwd|fwd)\b.*\b(?:awd|4wd|rwd|fwd)\b/, "AWD, RWD & FWD"],
  [/\bturbo ?lag\b/, "Turbo Lag"],
  [/\b(?:dct|dual[- ]clutch|dsg|pdk)\b/, "Dual-Clutch Transmissions"],
  [/\bcvt\b/, "CVT Transmissions"],
  [/\btorque converter/, "Torque Converters"],
  [/\b(?:lsd|limited[- ]slip)\b/, "Limited-Slip Differentials"],
  [/\bintercooler/, "Intercoolers"],
  [/\bdownpipe/, "Downpipes"],
  [/\bturbo/, "Turbochargers"],
  [/\bsupercharg/, "Superchargers"],
  [/\b(?:knock|detonation)\b/, "Engine Knock"],
  [/\bmisfir/, "Engine Misfires"],
  [/\b(?:check engine|engine light|obd|dtc|trouble code)/, "Check Engine Light"],
  [/\b(?:suspension|coilover|handling|camber|alignment|sway ?bar|springs?)\b/, "Suspension & Handling"],
  [/\b(?:brakes?|rotors?|calipers?|pads)\b/, "Brakes"],
  [/\b(?:ecu|tune|tuning|remap)\b/, "Engine Tuning"],
  [/\bexhaust\b/, "Exhaust Systems"],
  [/\b(?:tires?|tyres?|grip|traction)\b/, "Tires & Traction"],
  [/\b(?:oil|maintenance|service)\b/, "Maintenance"],
  [/\breliab/, "Reliability"],
  [/\btransmission|gearbox|gear ratio|final drive/, "Transmissions & Gearing"],
  [/\b(?:ev|evs|electric|battery|hybrid)\b/, "Electric & Hybrid"],
  [/\b(?:0-60|0-100|quarter-mile|acceleration)\b/, "Acceleration"],
  [/\b(?:weight|lighter|mass)\b/, "Weight & Performance"],
  [/\bfeasib/, "Feasibility"],
  [/\baero|downforce|drag\b/, "Aerodynamics"],
];

const COMPONENT_UPGRADE: [RegExp, string][] = [
  [/\bturbo/, "Turbo"],
  [/\bsupercharg/, "Supercharger"],
  [/\bexhaust|downpipe/, "Exhaust"],
  [/\bintake/, "Intake"],
  [/\btune|ecu|remap/, "Tune"],
  [/\bcoilover|suspension/, "Suspension"],
  [/\btires?|tyres?/, "Tire"],
  [/\bbrakes?/, "Brake"],
];

const ACRONYMS = new Set(["amg", "gti", "wrx", "sti", "brz", "srt", "gt", "gtr", "gt-r", "rs", "si", "ss", "rt", "trd", "nsx", "awd", "tt", "gt3", "m"]);
const MODEL_SET = new Set(MODELS);
const MAKE_SET = new Set(MAKES);

function displayWord(w: string) {
  const lower = w.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  if (/\d/.test(w)) return w.replace(/^[a-z]+/, (m) => m.toUpperCase()); // c300 → C300, m340i → M340i
  return w[0].toUpperCase() + w.slice(1);
}

/** Vehicles named in a message, e.g. ["2015 C300", "M340i"]. */
export function vehiclesIn(text: string): string[] {
  const words = text.replace(/[^\w\s-]/g, " ").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase();
    const isCode = /^[a-z]{1,3}\d{2,4}[a-z]{0,2}$/.test(w) && !/^(?:0|19|20)\d/.test(w);
    if (!MODEL_SET.has(w) && !(isCode && i > 0 && MAKE_SET.has(words[i - 1].toLowerCase()))) continue;
    let label = displayWord(words[i]);
    const next = words[i + 1]?.toLowerCase();
    if (next && ACRONYMS.has(next)) {
      label += ` ${next.toUpperCase()}`;
      i += 1;
    }
    const year = [words[i - 1], words[i - 2], words[i - 3]].find((x) => x && /^(?:19[3-9]\d|20[0-4]\d)$/.test(x));
    if (year && !out.length) label = `${year} ${label}`;
    if (!out.includes(label)) out.push(label);
  }
  return out.slice(0, 2);
}

function modification(norm: string): string | null {
  const power = norm.match(/([+-]?)\s*(\d{1,4})\s*(?:extra |more |additional )?(?:hp|horsepower|bhp|whp)\b/);
  if (power) {
    const less = power[1] === "-" || /\b(?:less|lose|losing|remove|drop|minus|reduce)\b[^.?!]*\b\d+\s*(?:hp|horsepower)/.test(norm);
    return `${less ? "−" : "+"}${power[2]} hp`;
  }
  const mass = norm.match(/([+-]?)\s*(\d{1,4})\s*(lb|lbs|pounds|kg)\b/);
  if (mass) {
    const more = mass[1] === "+" || /\b(?:add|adding|heavier|gain)\b/.test(norm);
    return `${more ? "+" : "−"}${mass[2]} ${mass[3] === "kg" ? "kg" : "lb"}`;
  }
  if (/\b(?:upgrade|upgrading|swap|install|installing|add|adding|bigger)\b/.test(norm)) {
    const c = COMPONENT_UPGRADE.find(([re]) => re.test(norm));
    if (c) return `${c[1]} Upgrade`;
  }
  return null;
}

const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX - 1).trimEnd()}…` : s);

/** "2018 Jaguar F-Type R", "Jaguar V8", "F-Type R vs M4" from the tracked conversation subject. */
function subjectTitle(t: Topic | null): string | null {
  if (!t) return null;
  const vehicles = t.models.length ? t.models : t.makes;
  if (!vehicles.length) return null;
  const engine = !t.models.length && t.engines[0] ? ` ${t.engines[0]}` : "";
  if (vehicles.length >= 2) return `${vehicles.slice(0, 2).join(" vs ")}${engine}`;
  const make = t.models.length && t.makes[0] && !vehicles[0].toLowerCase().includes(t.makes[0].toLowerCase()) ? `${t.makes[0]} ` : "";
  return `${t.years.length === 1 ? `${t.years[0]} ` : ""}${make}${vehicles[0]}${engine}`;
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (m) => m.toUpperCase());

/**
 * Title from the first meaningful user messages and the vehicle in context (short label such as
 * "2015 C300"). Returns DEFAULT_TITLE when nothing useful can be derived.
 */
export function generateTitle(userMessages: string[], currentVehicle: string | null, tracked: Topic | null = null): string {
  const text = userMessages.slice(0, 3).join(" ");
  if (!text.trim()) return DEFAULT_TITLE;
  const norm = normalize(text);
  const vehicles = vehiclesIn(text);
  const topic = TOPICS.find(([re]) => re.test(norm))?.[1] ?? null;
  const mod = modification(norm);

  if (vehicles.length >= 2 || (vehicles.length === 1 && /\b(?:vs|versus)\b/.test(norm) && currentVehicle)) {
    const [a, b] = vehicles.length >= 2 ? vehicles : [currentVehicle!, vehicles[0]];
    return clip(`${a} vs ${b}`);
  }
  // The conversation's tracked vehicle subject names it better than stray words in its first
  // messages (a Jaguar chat that mentions intercoolers is still a Jaguar chat).
  const subject = subjectTitle(tracked);
  if (subject && !mod) {
    const facet = !tracked!.comparing && aspectLabel(tracked!.aspect);
    return clip(facet ? `${subject} — ${titleCase(facet)}` : subject);
  }
  const refersToCurrent = /\b(?:my|this|the current|our)\s+(?:\w+\s+)?(?:car|vehicle|build|setup|ride|results?)\b/.test(norm) || !!mod;
  const vehicle = vehicles[0] ?? (refersToCurrent ? currentVehicle : null);
  const detail = mod ?? topic;
  if (vehicle && detail) return clip(`${vehicle} — ${detail}`);
  if (vehicle) return clip(vehicle);
  if (topic) return clip(/^(?:how|what|why|explain|when)\b/.test(norm) && !topic.includes(" vs ") ? `Understanding ${topic}` : topic);
  return DEFAULT_TITLE;
}

/** Short vehicle label for titles: "2015 C300". */
export function shortVehicle(identity: { year: number | null; model: string } | null): string | null {
  if (!identity) return null;
  return [identity.year, identity.model].filter(Boolean).join(" ").slice(0, 40) || null;
}
