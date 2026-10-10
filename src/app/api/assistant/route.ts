import { NextResponse } from "next/server";
import { aiConfig, deploymentInfo, geminiCaller, lastProviderHealth } from "@/lib/ai/gemini.server";
import { handleAssistantRequest } from "@/lib/ai/handler";
import { clientKeyFrom, getRateLimiter } from "@/lib/ai/rateLimit.server";
import type { AssistantStatus } from "@/lib/ai/types";
import { allDatasetTrims, datasetSpecSet } from "@/lib/vehicles/dataset.server";
import { nhtsaModels } from "@/lib/vehicles/nhtsa.server";
import { lookupFuelEconomy, lookupRecalls } from "@/lib/vehicles/ownershipData.server";

export const maxDuration = 30;

const noStore = { "Cache-Control": "no-store" };
const MAX_BODY = 64_000;

/** Configuration status only (no provider call). Use /api/assistant/health?probe=1 for a live check. */
export async function GET() {
  const cfg = aiConfig();
  const body: AssistantStatus = { configured: !!cfg.apiKey, model: cfg.model, deployment: deploymentInfo(), provider: lastProviderHealth(), configNotes: cfg.configNotes, env: cfg.env };
  return NextResponse.json(body, { headers: noStore });
}

export async function POST(request: Request) {
  const bad = (status: number, message: string) =>
    NextResponse.json({ ok: false, code: "invalid_request", message }, { status, headers: noStore });

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return bad(413, "Request too large.");
  if (!request.headers.get("content-type")?.includes("application/json")) return bad(415, "Expected JSON.");

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return bad(413, "Request too large.");
    body = JSON.parse(text);
  } catch {
    return bad(400, "That request could not be processed.");
  }

  const cfg = aiConfig();
  const result = await handleAssistantRequest(body, {
    configured: !!cfg.apiKey,
    timeoutMs: cfg.timeoutMs + 1000,
    callModel: geminiCaller,
    limiter: getRateLimiter(),
    clientKey: await clientKeyFrom(request.headers),
    trims: allDatasetTrims,
    specSetFor: datasetSpecSet,
    nhtsaModels,
    ownership: {
      fuelEconomy: (q, signal) => lookupFuelEconomy(q, { signal }),
      recalls: (q, signal) => lookupRecalls(q, { signal }),
    },
  });
  const headers: Record<string, string> = { ...noStore };
  if (!result.body.ok && result.body.retryAfterS) headers["Retry-After"] = String(result.body.retryAfterS);
  return NextResponse.json(result.body, { status: result.status, headers });
}
