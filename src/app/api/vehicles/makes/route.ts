import { datasetMakes } from "@/lib/vehicles/dataset.server";
import { hasDatasetSpecs, IDENTIFICATION_MAKES } from "@/lib/vehicles/catalog";
import { jsonError, jsonOk, parseYear } from "@/lib/vehicles/http";

export async function GET(request: Request) {
  const year = parseYear(new URL(request.url).searchParams.get("year"));
  if (!year) return jsonError(400, "A valid model year (1981 or later) is required.");
  if (hasDatasetSpecs(year)) return jsonOk({ year, source: "dataset", makes: datasetMakes(year) }, 86400);
  return jsonOk({ year, source: "nhtsa", makes: IDENTIFICATION_MAKES }, 86400);
}
