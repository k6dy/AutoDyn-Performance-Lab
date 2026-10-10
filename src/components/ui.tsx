"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Provenance } from "@/lib/domain/types";
import { PROVENANCE_LABEL } from "@/lib/domain/types";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" };

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        variant === "primary" && "bg-accent text-[#16110d] hover:bg-accent-strong",
        variant === "secondary" && "border border-line-strong bg-raised text-ink hover:border-faint hover:bg-hover",
        variant === "ghost" && "text-muted hover:bg-raised hover:text-ink",
        variant === "danger" && "border border-error/40 text-error hover:bg-error/10",
        className,
      )}
    />
  );
}

export function Panel({ title, subtitle, actions, children, className, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cx("print-plain print-break rounded-lg border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] leading-5 text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-md border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-[4px] font-medium transition-colors duration-150 disabled:opacity-35",
            size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
            value === o.value ? "bg-raised text-ink shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "text-muted hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const PROV_STYLE: Record<Provenance, string> = {
  verified: "text-verified border-verified/35",
  user: "text-user border-user/35",
  estimated: "text-estimated border-estimated/35",
  unavailable: "text-unavailable border-unavailable/35",
};

export function ProvenanceTag({ provenance, title, compact, label }: { provenance: Provenance; title?: string; compact?: boolean; label?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex h-[18px] shrink-0 items-center rounded-sm border px-1.5 text-[10.5px] font-medium tracking-wide uppercase", PROV_STYLE[provenance])}
    >
      {label ?? (compact ? PROVENANCE_LABEL[provenance].slice(0, 4) : PROVENANCE_LABEL[provenance])}
    </span>
  );
}

/** Scenario identity: color plus shape plus text, so it never relies on color alone. */
export function ScenarioTag({ scenario, label }: { scenario: "stock" | "modified"; label?: string }) {
  const stock = scenario === "stock";
  return (
    <span data-scenario={scenario} className={cx("inline-flex items-center gap-1.5 font-medium", stock ? "text-stock" : "text-modified")}>
      <span aria-hidden className={cx("inline-block h-2 w-2 shrink-0", stock ? "rounded-full bg-stock" : "rotate-45 bg-modified")} />
      {label ?? (stock ? "Stock" : "Modified")}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label={label ?? "Loading"}>
      <span className="loading-dot h-1.5 w-1.5 rounded-full bg-accent" />
      <span className="loading-dot h-1.5 w-1.5 rounded-full bg-accent [animation-delay:150ms]" />
      <span className="loading-dot h-1.5 w-1.5 rounded-full bg-accent [animation-delay:300ms]" />
    </span>
  );
}

export function Notice({ tone = "info", children, action }: { tone?: "info" | "warning" | "error" | "success"; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "flex flex-wrap items-start justify-between gap-3 rounded-md border px-3 py-2.5 text-[13px] leading-5",
        tone === "info" && "border-line bg-raised text-muted",
        tone === "warning" && "border-warning/35 bg-warning/8 text-[#f1d39e]",
        tone === "error" && "border-error/40 bg-error/8 text-[#f5a8a8]",
        tone === "success" && "border-success/35 bg-success/8 text-[#a9e3cd]",
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const subscribeMotion = (cb: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true,
  );
}

/** Tweens a number on change (transform-free text update; skipped with reduced motion). */
export function AnimatedNumber({ value, digits }: { value: number; digits: number }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reduced || from.current === value) {
      from.current = value;
      const id = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(id);
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / 420, 1);
      const e = 1 - Math.pow(1 - t, 3);
      setShown(a + (value - a) * e);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);
  return <>{shown.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}</>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm border border-line-strong bg-raised px-1 font-mono text-[10.5px] text-muted">{children}</kbd>;
}
