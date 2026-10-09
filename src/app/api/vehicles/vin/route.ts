import { jsonError, jsonOk } from "@/lib/vehicles/http";
import { decodeVin, isValidVin, ProviderError } from "@/lib/vehicles/nhtsa.server";

export async function GET(request: Request) {
  const vin = (new URL(request.url).searchParams.get("vin") ?? "").trim().toUpperCase();
  if (!isValidVin(vin)) return jsonError(400, "Enter a 17-character VIN (letters I, O and Q are not used).");
  try {
    const specSet = await decodeVin(vin);
    if (!specSet) return jsonError(404, "NHTSA could not decode that VIN. Check it or enter the vehicle manually.");
    return jsonOk({ specSet });
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : "VIN decoding failed.";
    return jsonError(502, `${message} Retry, or enter the vehicle manually.`, { retryable: true });
  }
}
