import { datasetModels } from "@/lib/vehicles/dataset.server";
import { hasDatasetSpecs } from "@/lib/vehicles/catalog";
import { cleanText, jsonError, jsonOk, parseYear } from "@/lib/vehicles/http";
import { nhtsaModels, ProviderError } from "@/lib/vehicles/nhtsa.server";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const year = parseYear(params.get("year"));
  const make = cleanText(params.get("make"), 60);
  if (!year || !make) return jsonError(400, "Model year and make are required.");

  if (hasDatasetSpecs(year)) {
    return jsonOk({ year, make, source: "dataset", models: datasetModels(year, make) }, 86400);
  }
  try {
    const models = await nhtsaModels(make, year);
    return jsonOk({ year, make, source: "nhtsa", models }, 86400);
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "Vehicle lookup failed.";
    return jsonError(502, `${message} Retry, or enter the vehicle as a custom vehicle.`, { retryable: true });
  }
}
