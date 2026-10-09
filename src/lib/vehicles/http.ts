import { NextResponse } from "next/server";

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonOk(body: unknown, cacheSeconds = 0) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": cacheSeconds ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}` : "no-store",
    },
  });
}

export function parseYear(value: string | null) {
  const y = Number(value);
  return Number.isInteger(y) && y >= 1981 && y <= new Date().getFullYear() + 1 ? y : null;
}

/** Accepts plain vehicle names only (letters, digits, common punctuation). */
export function cleanText(value: string | null, max = 80) {
  const v = (value ?? "").trim();
  return v && v.length <= max && /^[\p{L}\p{N} .,&'()/+-]+$/u.test(v) ? v : null;
}
