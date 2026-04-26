import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

type CsvRow = Record<string, string>;

function loadCsv(fileName: string): CsvRow[] {
  const filePath = path.join(process.cwd(), "src", "data", "carapi", fileName);
  const file = fs.readFileSync(filePath, "utf-8");

  return parse(file, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  }) as CsvRow[];
}

const makes = loadCsv("makes-sample.csv");
const models = loadCsv("models-sample.csv");
const trims = loadCsv("trims-sample.csv");
const engines = loadCsv("engines-sample.csv");
const bodies = loadCsv("bodies-sample.csv");
const mileages = loadCsv("mileages-sample.csv");

function lower(value: string | undefined) {
  return (value ?? "").toLowerCase().trim();
}

function toNumber(value: string | undefined) {
  if (!value) return "";
  const num = Number(value);
  return Number.isFinite(num) ? num : "";
}

function lbsToKg(value: string | undefined) {
  const lbs = Number(value);
  if (!Number.isFinite(lbs)) return "";
  return Math.round(lbs * 0.453592);
}

function estimateCd(bodyType: string) {
  const body = lower(bodyType);

  if (body.includes("coupe")) return 0.3;
  if (body.includes("sedan")) return 0.29;
  if (body.includes("hatch")) return 0.32;
  if (body.includes("wagon")) return 0.34;
  if (body.includes("suv")) return 0.38;
  if (body.includes("truck")) return 0.45;

  return 0.32;
}

function estimateFrontalArea(bodyType: string) {
  const body = lower(bodyType);

  if (body.includes("coupe")) return 2.0;
  if (body.includes("sedan")) return 2.2;
  if (body.includes("hatch")) return 2.15;
  if (body.includes("wagon")) return 2.35;
  if (body.includes("suv")) return 2.7;
  if (body.includes("truck")) return 2.9;

  return 2.25;
}

function estimateDrivetrainLoss(driveType: string) {
  const drive = lower(driveType);

  if (drive.includes("front")) return 0.13;
  if (drive.includes("rear")) return 0.15;
  if (drive.includes("all") || drive.includes("4")) return 0.2;

  return 0.15;
}

export function getDatasetMakes() {
  return Array.from(
    new Set(makes.map((row) => row["Make Name"]).filter(Boolean))
  ).sort();
}

export function getDatasetYearsForMake(make: string) {
  return Array.from(
    new Set(
      models
        .filter((row) => lower(row["Make Name"]) === lower(make))
        .map((row) => row["Model Year"])
        .filter(Boolean)
    )
  )
    .map(Number)
    .sort((a, b) => b - a);
}

export function getDatasetModels(make: string, year: number) {
  return Array.from(
    new Set(
      models
        .filter(
          (row) =>
            lower(row["Make Name"]) === lower(make) &&
            Number(row["Model Year"]) === year
        )
        .map((row) => row["Model Name"])
        .filter(Boolean)
    )
  ).sort();
}

export function getDatasetTrims(make: string, model: string, year: number) {
  return trims
    .filter(
      (row) =>
        lower(row["Make Name"]) === lower(make) &&
        lower(row["Model Name"]) === lower(model) &&
        Number(row["Model Year"]) === year
    )
    .map((row) => ({
      id: row["Trim Id"],
      label:
        row["Trim Name"] && row["Trim Description"]
          ? `${row["Trim Name"]} — ${row["Trim Description"]}`
          : row["Trim Name"] || row["Trim Description"] || row["Trim Id"],
    }))
    .filter((trim) => trim.id && trim.label);
}

export function getDatasetVehicleSpecs(trimId: string) {
  const trim = trims.find((row) => row["Trim Id"] === trimId);
  if (!trim) return null;

  const engine = engines.find((row) => row["Trim Id"] === trimId);
  const body = bodies.find((row) => row["Trim Id"] === trimId);
  const mileage = mileages.find((row) => row["Trim Id"] === trimId);

  const bodyType = body?.["Body Type"] ?? "";
  const driveType = engine?.["Engine Drive Type"] ?? "";

  return {
    trim: trim["Trim Name"] ?? "",
    trimDescription: trim["Trim Description"] ?? "",
    engine: [
      engine?.["Engine Size"] ? `${engine["Engine Size"]}L` : "",
      engine?.["Engine Cylinders"] ?? "",
      engine?.["Engine Type"] ?? "",
    ]
      .filter(Boolean)
      .join(" "),
    horsepower: toNumber(engine?.["Engine Horsepower Hp"]),
    modifiedHorsepower: toNumber(engine?.["Engine Horsepower Hp"]),
    torqueLbFt: toNumber(engine?.["Engine Torque Ft Lbs"]),
    weightKg: lbsToKg(body?.["Body Curb Weight"]),
    drivetrain: driveType,
    transmission: engine?.["Engine Transmission"] ?? "",
    bodyStyle: bodyType,
    mpgCombined: toNumber(mileage?.["Mileage Combined Mpg"]),
    dragCoefficient: estimateCd(bodyType),
    frontalAreaM2: estimateFrontalArea(bodyType),
    drivetrainLoss: estimateDrivetrainLoss(driveType),
    tireGrip: 0.95,
  };
}