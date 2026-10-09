// Builds src/data/vehicle-index.json from the CarAPI sample CSV exports.
// Run with: npm run data:build
// Only columns the app actually uses are kept; empty cells become null so missing
// specifications stay visibly missing instead of being filled with defaults.
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const dataDir = path.join(root, "src", "data", "carapi");

function load(name) {
  return parse(fs.readFileSync(path.join(dataDir, name), "utf-8"), {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === undefined || v === null || v === "" ? null : String(v));

const trims = load("trims-sample.csv");
const engines = new Map(load("engines-sample.csv").map((r) => [r["Trim Id"], r]));
const bodies = new Map(load("bodies-sample.csv").map((r) => [r["Trim Id"], r]));

const columns = [
  "id", "year", "make", "model", "submodel", "trim", "description", "msrp",
  "engineType", "fuel", "cylinders", "displacementL", "hp", "hpRpm", "torqueLbFt", "torqueRpm",
  "drive", "transmission", "body", "doors", "curbWeightLb", "widthIn", "heightIn", "wheelbaseIn",
];

const rows = trims
  .map((t) => {
    const e = engines.get(t["Trim Id"]) ?? {};
    const b = bodies.get(t["Trim Id"]) ?? {};
    return [
      str(t["Trim Id"]), num(t["Model Year"]), str(t["Make Name"]), str(t["Model Name"]),
      str(t["Submodel Name"]), str(t["Trim Name"]), str(t["Trim Description"]), num(t["Trim MSRP"]),
      str(e["Engine Type"]), str(e["Engine Fuel Type"]), str(e["Engine Cylinders"]), num(e["Engine Size"]),
      num(e["Engine Horsepower Hp"]), num(e["Engine Horsepower Rpm"]), num(e["Engine Torque Ft Lbs"]), num(e["Engine Torque Rpm"]),
      str(e["Engine Drive Type"]), str(e["Engine Transmission"]), str(b["Body Type"]), num(b["Body Doors"]),
      num(b["Body Curb Weight"]), num(b["Body Width"]), num(b["Body Height"]), num(b["Body Wheel Base"]),
    ];
  })
  .filter((r) => r[0] && r[1] && r[2] && r[3])
  .sort((a, b) => b[1] - a[1] || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]) || String(a[5]).localeCompare(String(b[5])));

const out = {
  source: {
    name: "CarAPI sample dataset",
    url: "https://carapi.app",
    note: "Manufacturer-published specifications for 2015–2020 US-market trims, as exported by CarAPI.",
  },
  columns,
  rows,
};

fs.writeFileSync(path.join(root, "src", "data", "vehicle-index.json"), JSON.stringify(out));
console.log(`vehicle-index.json: ${rows.length} trims`);
