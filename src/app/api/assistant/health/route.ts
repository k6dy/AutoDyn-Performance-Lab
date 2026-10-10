import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { aiConfig, deploymentInfo, lastProviderHealth, modelVisibility, probeProvider, verifyAccess } from "@/lib/ai/gemini.server";
import { clientKeyFrom, MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import type { AssistantStatus } from "@/lib/ai/types";

export const maxDuration = 25;

const noStore = { "Cache-Control": "no-store" };

// Separate, small budgets so diagnostics can never eat into (or be amplified by) assistant traffic.
const accessLimiter = new MemoryRateLimiter({ perMinute: 3, perDay: 60, globalPerDay: 500 });
const diagnosticsLimiter = new MemoryRateLimiter({ perMinute: 2, perDay: 20, globalPerDay: 20 });

function hasDiagnosticsToken(request: Request) {
  const expected = process.env.AI_DIAGNOSTICS_TOKEN?.trim();
  if (!expected || expected.length < 16) return false;
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Readiness check. Never returns secrets.
 *  • No params: configuration presence, deployment identity and the last real provider result.
 *  • ?probe=1 from the app's own pages: verifies the key and model through model metadata — no
 *    generation request, no token quota — cached per instance and rate limited.
 *  • Authorization: Bearer $AI_DIAGNOSTICS_TOKEN with ?probe=1: one real bounded generation in the
 *    production request format (consumes quota), strictly rate limited; ?models=1 also lists the
 *    Flash-Lite models visible to the API project. Disabled unless the token is configured.
 */
export async function GET(request: Request) {
  const cfg = aiConfig();
  const params = new URL(request.url).searchParams;
  const admin = hasDiagnosticsToken(request);
  let provider = lastProviderHealth();
  let note: string | undefined;
  let probe: "access" | "generation" | null = null;

  if (params.get("probe") === "1" && cfg.apiKey) {
    if (admin) {
      const limit = await diagnosticsLimiter.check("diagnostics");
      if (limit.allowed) {
        provider = await probeProvider(undefined, { force: true });
        probe = "generation";
      } else note = `Diagnostic probe rate limit reached; retry in ${limit.retryAfterS} s.`;
    } else {
      const site = request.headers.get("sec-fetch-site");
      if (site !== "same-origin" && site !== "none") {
        note = "Live checks are limited to the app itself or requests with the diagnostics token.";
      } else {
        const limit = await accessLimiter.check(await clientKeyFrom(request.headers));
        if (limit.allowed) {
          provider = await verifyAccess();
          probe = "access";
        } else note = "Check skipped: rate limit reached. Showing the last known result.";
      }
    }
  }

  const body: AssistantStatus & { note?: string; probe?: typeof probe; models?: Awaited<ReturnType<typeof modelVisibility>> } = {
    configured: !!cfg.apiKey,
    model: cfg.model,
    deployment: deploymentInfo(),
    provider,
    configNotes: cfg.configNotes,
    env: cfg.env,
    probe,
    ...(note ? { note } : {}),
  };
  if (admin && params.get("models") === "1") body.models = await modelVisibility();
  return NextResponse.json(body, { headers: noStore });
}
