"use client";

import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cx, useReducedMotion } from "@/components/ui";
import type { BrandMark } from "@/lib/brand/marks";

const keyOf = (make: string) => make.toLowerCase().replace(/[^a-z0-9]/g, "");

let marksPromise: Promise<Record<string, BrandMark>> | null = null;
/** Brand marks are code-split and fetched on first use (or when a make is chosen). */
export function preloadBrandMarks() {
  marksPromise ??= import("@/lib/brand/marks").then((m) => m.BRAND_MARKS).catch(() => {
    marksPromise = null;
    return {};
  });
  return marksPromise;
}

function useBrandMark(make: string | null | undefined) {
  const [state, setState] = useState<{ key: string; mark: BrandMark | null } | null>(null);
  const key = make ? keyOf(make) : "";
  useEffect(() => {
    if (!key) return;
    let alive = true;
    preloadBrandMarks().then((marks) => alive && setState({ key, mark: marks[key] ?? null }));
    return () => {
      alive = false;
    };
  }, [key]);
  return state && state.key === key ? state.mark : null;
}

/**
 * Manufacturer mark from Simple Icons when available; otherwise a typographic mark with the
 * manufacturer's name, or the AutoDyn wordmark when no manufacturer is known.
 */
export function BrandGlyph({ make, size = 40 }: { make?: string | null; size?: number }) {
  const mark = useBrandMark(make);
  if (make && mark) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={`${mark.title} logo`} data-brand={mark.title} className="fill-ink">
        <path d={mark.path} />
      </svg>
    );
  }
  if (make) {
    const words = make.split(/[\s-]+/).filter(Boolean);
    const monogram = (words.length > 1 ? words.map((w) => w[0]).join("") : make.slice(0, 2)).slice(0, 3).toUpperCase();
    return size < 30 ? (
      <span data-brand-fallback={make} title={make} className="text-[13px] font-semibold tracking-wide text-ink">
        {monogram}
      </span>
    ) : (
      <span data-brand-fallback={make} className="max-w-[64px] text-center text-[10px] leading-tight font-semibold tracking-[0.08em] break-words text-ink uppercase">
        {make}
      </span>
    );
  }
  return (
    <span data-brand-fallback="AutoDyn" className="text-[13px] font-semibold tracking-tight text-ink">
      Auto<span className="text-accent">Dyn</span>
    </span>
  );
}

export type StageState = "loading" | "error";

/**
 * Loading indicator tied to a real request. Labels change only when the request phase changes;
 * there is no simulated progress. Fades in after a short delay so fast responses don't flash.
 */
export default function LoadingStage({
  make,
  label,
  state = "loading",
  detail,
  onRetry,
  compact,
}: {
  make?: string | null;
  label: string;
  state?: StageState;
  detail?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const reduced = useReducedMotion();
  const error = state === "error";
  const size = compact ? 64 : 92;
  return (
    <div
      role={error ? "alert" : "status"}
      aria-live="polite"
      data-stage={state}
      data-reduced-motion={reduced ? "true" : "false"}
      className={cx("flex flex-col items-center justify-center gap-3 text-center", compact ? "py-3" : "py-8", !error && "animate-fade-delayed")}
    >
      <div className="relative grid place-items-center" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden>
          <circle cx="50" cy="50" r="46" fill="none" stroke="var(--color-line)" strokeWidth="1" />
          {Array.from({ length: 36 }, (_, i) => (
            <line
              key={i}
              x1="50"
              y1="2.5"
              x2="50"
              y2={i % 9 === 0 ? "8" : "5.5"}
              stroke={i % 9 === 0 ? "var(--color-line-strong)" : "var(--color-line)"}
              strokeWidth="1"
              transform={`rotate(${i * 10} 50 50)`}
            />
          ))}
          <g
            className={cx(!error && !reduced && "animate-ring")}
            style={{ transformBox: "view-box", transformOrigin: "50px 50px" }}
          >
            <circle
              cx="50"
              cy="50"
              r="46"
              fill="none"
              stroke={error ? "var(--color-error)" : "var(--color-accent)"}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeDasharray={error ? "289 0" : "52 237"}
            />
          </g>
        </svg>
        <div className={cx("grid place-items-center", error && "opacity-50")}>
          <BrandGlyph make={make} size={compact ? 26 : 38} />
        </div>
      </div>
      <div className="min-h-[20px]">
        <p key={label} className={cx("animate-fade text-[13px] font-medium", error ? "text-error" : "text-ink")}>
          {label}
        </p>
        {detail && <p className="mt-0.5 max-w-sm text-xs leading-4 text-muted">{detail}</p>}
      </div>
      {error && onRetry && (
        <Button size="sm" onClick={onRetry}>
          <RotateCcw size={14} aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}
