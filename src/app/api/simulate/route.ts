import { NextResponse } from "next/server";
import { explainAnalysis } from "@/lib/analysis/explain";
import { configSchema } from "@/lib/domain/configSchema";
import type { AnalysisConfig } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { runAnalysis } from "@/lib/physics/analysis";

// The same deterministic engine the UI runs in the browser, exposed for scripted use.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid configuration.", issues: parsed.error.issues.slice(0, 10) }, { status: 400 });
  }
  const config = parsed.data as AnalysisConfig;
  const validation = validateConfig(config);
  if (validation.errors) {
    return NextResponse.json({ error: "Configuration failed validation.", issues: validation.issues }, { status: 422 });
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
    { headers: { "Cache-Control": "no-store" } },
  );
}
