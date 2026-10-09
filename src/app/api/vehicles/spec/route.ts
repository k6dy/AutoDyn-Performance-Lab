import { datasetSpecSet, datasetTrim } from "@/lib/vehicles/dataset.server";
import { jsonError, jsonOk } from "@/lib/vehicles/http";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("trimId") ?? "";
  if (!/^\d{1,10}$/.test(id)) return jsonError(400, "A valid trim id is required.");
  const trim = datasetTrim(id);
  if (!trim) return jsonError(404, "That trim is not in the specification dataset.");
  return jsonOk({ specSet: datasetSpecSet(trim) }, 86400);
}
