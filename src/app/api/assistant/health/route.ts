import { NextResponse } from "next/server";
import { aiConfig, deploymentInfo, lastProviderHealth, probeProvider } from "@/lib/ai/gemini.server";
import { clientKeyFrom } from "@/lib/ai/rateLimit.server";
import type { AssistantStatus } from "@/lib/ai/types";

export const maxDuration = 20;

// Per-instance throttle for live probes; the probe result itself is cached (10 min ok / 1 min failure).
const lastProbeByClient = new Map<string, number>();
const PROBE_INTERVAL_MS = 15_000;

/**
 * Readiness check. Without ?probe=1 it reports configuration and the last known provider result.
 * With ?probe=1 it makes one real, bounded Gemini request (production request format) to verify
 * key authorization, model availability and schema compatibility. Never returns the key.
 */
export async function GET(request: Request) {
  const cfg = aiConfig();
  const wantsProbe = new URL(request.url).searchParams.get("probe") === "1";
  let provider = lastProviderHealth();

  if (wantsProbe && cfg.apiKey) {
    const key = await clientKeyFrom(request.headers);
    const now = Date.now();
    const last = lastProbeByClient.get(key) ?? 0;
    if (now - last >= PROBE_INTERVAL_MS || !provider) {
      lastProbeByClient.set(key, now);
      if (lastProbeByClient.size > 2000) lastProbeByClient.clear();
      provider = await probeProvider();
    }
  }

  const body: AssistantStatus = { configured: !!cfg.apiKey, model: cfg.model, deployment: deploymentInfo(), provider };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
