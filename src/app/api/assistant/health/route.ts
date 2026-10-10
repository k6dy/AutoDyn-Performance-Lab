import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { aiConfig, deploymentInfo, lastProviderHealth, modelVisibility, probeProvider } from "@/lib/ai/gemini.server";
import { clientKeyFrom, getRateLimiter } from "@/lib/ai/rateLimit.server";
import type { AssistantStatus } from "@/lib/ai/types";

export const maxDuration = 25;

const noStore = { "Cache-Control": "no-store" };

function hasDiagnosticsToken(request: Request) {
  const expected = process.env.AI_DIAGNOSTICS_TOKEN?.trim();
  if (!expected || expected.length < 16) return false;
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Readiness check.
 *  • No params: configuration, deployment identity and the last real provider result. No provider call.
 *  • ?probe=1 (same-origin page requests): one real bounded Gemini request, cached per instance
 *    (10 min success / 2 min failure) and charged to the normal AI rate limits.
 *  • Authorization: Bearer $AI_DIAGNOSTICS_TOKEN: forces a fresh probe and lists which Flash-Lite
 *    models the API project can see. Never returns the key.
 */
export async function GET(request: Request) {
  const cfg = aiConfig();
  const params = new URL(request.url).searchParams;
  const admin = hasDiagnosticsToken(request);
  let provider = lastProviderHealth();
  let note: string | undefined;

  if (params.get("probe") === "1" && cfg.apiKey) {
    const site = request.headers.get("sec-fetch-site");
    const sameOrigin = site === "same-origin" || site === "none";
    if (admin) {
      provider = await probeProvider(undefined, { force: true });
    } else if (!sameOrigin) {
      note = "Live probes are limited to the app itself or requests with the diagnostics token.";
    } else {
      const limit = await getRateLimiter().check(await clientKeyFrom(request.headers));
      if (limit.allowed) provider = await probeProvider();
      else note = "Probe skipped: rate limit reached. Showing the last known result.";
    }
  }

  const body: AssistantStatus & { note?: string; models?: Awaited<ReturnType<typeof modelVisibility>> } = {
    configured: !!cfg.apiKey,
    model: cfg.model,
    deployment: deploymentInfo(),
    provider,
    configNotes: cfg.configNotes,
    ...(note ? { note } : {}),
  };
  if (admin && params.get("models") === "1") body.models = await modelVisibility();
  return NextResponse.json(body, { headers: noStore });
}
