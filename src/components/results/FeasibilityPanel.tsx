"use client";

import { Ban, CheckCircle2, ChevronDown, CircleDashed, CircleHelp, MinusCircle, TriangleAlert, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { cx, ProvenanceTag, ScenarioTag } from "@/components/ui";
import { FEASIBILITY_LABEL, type CheckOutcome, type FeasibilityAssessment, type FeasibilityStatus } from "@/lib/feasibility/types";

const STATUS_STYLE: Record<FeasibilityStatus, { icon: typeof CheckCircle2; text: string; border: string; bg: string }> = {
  feasible: { icon: CheckCircle2, text: "text-feasible", border: "border-feasible/40", bg: "bg-feasible/8" },
  questionable: { icon: TriangleAlert, text: "text-questionable", border: "border-questionable/40", bg: "bg-questionable/8" },
  non_feasible: { icon: Ban, text: "text-nonfeasible", border: "border-nonfeasible/45", bg: "bg-nonfeasible/8" },
  insufficient_data: { icon: CircleHelp, text: "text-insufficient", border: "border-insufficient/40", bg: "bg-insufficient/8" },
};

const OUTCOME_STYLE: Record<CheckOutcome, { icon: typeof CheckCircle2; text: string; label: string }> = {
  pass: { icon: CheckCircle2, text: "text-feasible", label: "Satisfied" },
  caution: { icon: TriangleAlert, text: "text-questionable", label: "Needs verification" },
  violation: { icon: XCircle, text: "text-nonfeasible", label: "Violated" },
  not_assessed: { icon: CircleDashed, text: "text-insufficient", label: "Not assessed" },
};

export function FeasibilityBadge({ status }: { status: FeasibilityStatus }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span data-feasibility={status} className={cx("inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-semibold", s.text, s.border, s.bg)}>
      <Icon size={13} aria-hidden />
      {FEASIBILITY_LABEL[status]}
    </span>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h5 className="mb-1 text-xs font-semibold text-muted">{title}</h5>
      <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] leading-5 text-muted">
        {items.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function Assessment({ a }: { a: FeasibilityAssessment }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const before = () => setOpen(true);
    window.addEventListener("beforeprint", before);
    return () => window.removeEventListener("beforeprint", before);
  }, []);
  const s = STATUS_STYLE[a.status];
  const counts = a.checks.reduce<Record<CheckOutcome, number>>((acc, c) => ({ ...acc, [c.outcome]: acc[c.outcome] + 1 }), { pass: 0, caution: 0, violation: 0, not_assessed: 0 });
  return (
    <article data-testid={`feasibility-${a.scenario}`} className={cx("print-plain print-break min-w-0 rounded-lg border bg-surface", s.border)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <span className="text-[13px]">
          <ScenarioTag scenario={a.scenario} label={a.scenario === "stock" ? "Stock configuration" : "Modified configuration"} />
        </span>
        <FeasibilityBadge status={a.status} />
      </header>
      <div className="space-y-2 px-4 py-3">
        <p className={cx("text-[14px] font-semibold", s.text)}>{a.headline}</p>
        <p className="text-[13px] leading-5 text-muted">{a.primaryReason}</p>
        <p className="text-[11.5px] text-faint">
          {a.checks.length} constraints evaluated · {counts.pass} satisfied · {counts.caution} need verification · {counts.violation} violated · {counts.not_assessed} not assessed
        </p>
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="no-print flex w-full items-center justify-between border-t border-line px-4 py-2.5 text-left text-[13px] font-medium text-muted hover:text-ink"
      >
        View Engineering Assessment
        <ChevronDown size={16} aria-hidden className={cx("transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div className="animate-enter space-y-4 border-t border-line px-4 py-4">
          <div>
            <h5 className="mb-2 text-xs font-semibold text-muted">Constraints evaluated</h5>
            <ul className="space-y-2.5">
              {a.checks.map((c) => {
                const o = OUTCOME_STYLE[c.outcome];
                const Icon = o.icon;
                return (
                  <li key={c.id} data-check={c.id} data-outcome={c.outcome} className="flex gap-2.5">
                    <Icon size={15} className={cx("mt-0.5 shrink-0", o.text)} aria-hidden />
                    <div className="min-w-0 text-[12.5px] leading-5">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-ink">{c.label}</span>
                        <span className={cx("text-[11px] font-medium uppercase", o.text)}>{o.label}</span>
                      </div>
                      <p className="text-muted">{c.detail}</p>
                      {c.values && (
                        <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                          {c.values.map((v) => (
                            <div key={v.label} className="flex justify-between gap-2 text-[11.5px]">
                              <dt className="text-faint">{v.label}</dt>
                              <dd className="num text-right text-ink">{v.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <h5 className="mb-1 text-xs font-semibold text-muted">Inputs evaluated</h5>
            <ul className="grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-2">
              {a.inputs.map((i) => (
                <li key={i.label} className="flex items-center justify-between gap-2">
                  <span className="text-faint">{i.label}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="num text-ink">{i.value}</span>
                    <ProvenanceTag provenance={i.provenance} compact />
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <List title="Assumptions affecting the result" items={a.assumptions} />
          <List title="Missing information" items={a.missing} />
          <List title="Ways to improve confidence" items={a.suggestions} />
          <p className="flex items-start gap-1.5 text-[11.5px] leading-4 text-faint">
            <MinusCircle size={12} className="mt-0.5 shrink-0" aria-hidden />
            Deterministic assessment ({a.engineVersion}) of the modeled constraints only. It does not certify mechanical safety, road legality or real-world performance.
          </p>
        </div>
      )}
    </article>
  );
}

export default function FeasibilityPanel({ stock, modified }: { stock: FeasibilityAssessment | null; modified: FeasibilityAssessment | null }) {
  return (
    <section aria-label="Engineering feasibility" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight">Engineering feasibility</h2>
        <p className="text-xs text-faint">Feasible · Questionable · Non-feasible · Insufficient data — computed without AI</p>
      </div>
      <div className={cx("grid gap-4", stock && modified && "lg:grid-cols-2")}>
        {stock && <Assessment a={stock} />}
        {modified && <Assessment a={modified} />}
      </div>
    </section>
  );
}
