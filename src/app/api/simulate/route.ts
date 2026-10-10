import { NextResponse } from "next/server";
import { explainAnalysis } from "@/lib/analysis/explain";
import { clientKeyFrom, MemoryRateLimiter } from "@/lib/ai/rateLimit.server";
import { configSchema } from "@/lib/domain/configSchema";
import type { AnalysisConfig } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { runAnalysis } from "@/lib/physics/analysis";

// The same deterministic engine the UI runs in the browser, exposed for scripted use.
// It costs server CPU only (no provider call), so it gets a size cap and a generous per-instance
// rate limit against scripted hammering; the browser never calls this route.

export const maxDuration = 15;

const noStore = { "Cache-Control": "no-store" };
const MAX_BODY = 64_000;
const limiter = new MemoryRateLimiter({ perMinute: 30, perDay: 600, globalPerDay: 5000 });

export async function POST(request: Request) {
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers: noStore });

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return fail(413, "Request too large.");
  const limit = await limiter.check(await clientKeyFrom(request.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many simulation requests. Try again later.", retryAfterS: limit.retryAfterS },
      { status: 429, headers: { ...noStore, "Retry-After": String(limit.retryAfterS) } },
    );
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return fail(413, "Request too large.");
    body = JSON.parse(text);
  } catch {
    return fail(400, "Invalid JSON.");
  }
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, "Invalid configuration.", { issues: parsed.error.issues.slice(0, 10) });
  }
  const config = parsed.data as AnalysisConfig;
  const validation = validateConfig(config);
  if (validation.errors) {
    return fail(422, "Configuration failed validation.", { issues: validation.issues });
  }
  const result = runAnalysis(config);
  const strip = (s: typeof result.stock | null) => (s ? { ...s, samples: undefined, curve: undefined } : null);
  return NextResponse.json(
    {
      ...result,
      config: undefined,
      stock: strip(result.stock),
      modified: strip(result.modified),
      warnings: validation.issues,
      ...explainAnalysis(result),
    },
    { headers: noStore },
  );
}
