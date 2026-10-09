import { datasetTrims } from "@/lib/vehicles/dataset.server";
import { hasDatasetSpecs } from "@/lib/vehicles/catalog";
import { cleanText, jsonError, jsonOk, parseYear } from "@/lib/vehicles/http";
import { trimLabel } from "@/lib/vehicles/normalize";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const year = parseYear(params.get("year"));
  const make = cleanText(params.get("make"), 60);
  const model = cleanText(params.get("model"), 80);
  if (!year || !make || !model) return jsonError(400, "Model year, make and model are required.");
  if (!hasDatasetSpecs(year)) return jsonOk({ source: "nhtsa", trims: [] }, 86400);
  const trims = datasetTrims(year, make, model).map((t) => ({
    id: t.id,
    label: trimLabel(t),
    detail: [t.hp ? `${t.hp} hp` : "power n/a", t.drive, t.transmission].filter(Boolean).join(" · "),
    complete: t.hp != null && t.curbWeightLb != null,
  }));
  return jsonOk({ source: "dataset", trims }, 86400);
}
