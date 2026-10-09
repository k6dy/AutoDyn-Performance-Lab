"use client";

import { AlertTriangle, ArrowDownRight, ArrowUpRight, Download, FileJson, Info, Printer, RefreshCw, ShieldCheck, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { AccelChart, CurveChart, MassSweepChart, SensitivityChart, SpeedTimeChart } from "@/components/results/Charts";
import { AnimatedNumber, Button, cx, Notice, Panel, ProvenanceTag, Segmented, Spinner } from "@/components/ui";
import { explainAnalysis, type Finding } from "@/lib/analysis/explain";
import { buildCsvReport, buildJsonReport, buildTraceCsv } from "@/lib/analysis/export";
import { metricRows, rowDelta, type MetricRow } from "@/lib/analysis/metrics";
import { NUMERIC_FIELDS, SPEC_LABEL } from "@/lib/domain/fields";
import { effectiveValues } from "@/lib/domain/scenario";
import type { NumericSpecKey, Provenance, SpecKey } from "@/lib/domain/types";
import { SPEC_KEYS } from "@/lib/domain/types";
import type { AnalysisResult, ScenarioResult } from "@/lib/physics/analysis";
import { toDisplay, unitLabel, type UnitSystem } from "@/lib/units";
import { vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp } from "@/state/AppProvider";
import type { ResultsView } from "@/state/reducer";

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileBase = (r: AnalysisResult) =>
  `autodyn-${vehicleLabel(r.identity).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}-${r.createdAt.slice(0, 10)}`;

function Value({ v, digits, range }: { v: number | null; digits: number; range?: [number | null, number | null] | null }) {
  if (v == null) return <span className="text-faint">n/a</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="num text-[15px] text-ink">
        <AnimatedNumber value={v} digits={digits} />
      </span>
      {range && range[0] != null && range[1] != null && (
        <span className="num ml-1.5 text-[11px] text-faint">
          {Math.min(range[0], range[1]).toFixed(digits)}–{Math.max(range[0], range[1]).toFixed(digits)}
        </span>
      )}
    </span>
  );
}

function Delta({ row }: { row: MetricRow }) {
  const d = rowDelta(row);
  if (!d) return <span className="text-faint">—</span>;
  if (Math.abs(d.abs) < Math.pow(10, -row.digits) / 2) return <span className="text-faint">no change</span>;
  const color = d.improved == null ? "text-muted" : d.improved ? "text-gain" : "text-loss";
  const Icon = d.abs > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cx("num inline-flex items-center gap-1 whitespace-nowrap text-[13px]", color)}>
      <Icon size={13} aria-hidden />
      {d.abs > 0 ? "+" : "−"}
      {Math.abs(d.abs).toFixed(row.digits)}
      {d.rel != null && <span className="text-[11px] opacity-75">({d.rel > 0 ? "+" : ""}{d.rel.toFixed(1)}%)</span>}
    </span>
  );
}

function MetricsTable({ result, view, units }: { result: AnalysisResult; view: ResultsView; units: UnitSystem }) {
  const rows = metricRows(result, units).filter((r) => r.stock != null || r.modified != null);
  const showStock = view !== "modified";
  const showMod = view !== "stock" && !!result.modified;
  const showDelta = view === "compare" && !!result.modified;
  return (
    <div className="print-plain overflow-x-auto rounded-lg border border-line bg-surface scrollbar-thin">
      <table className="w-full min-w-[520px] text-left text-[13px]">
        <caption className="sr-only">Computed performance metrics</caption>
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th scope="col" className="px-4 py-2.5 font-medium">Metric</th>
            {showStock && <th scope="col" className="px-4 py-2.5 font-medium"><span className="inline-block h-2 w-2 rounded-full bg-stock align-middle" /> Stock</th>}
            {showMod && <th scope="col" className="px-4 py-2.5 font-medium"><span className="inline-block h-2 w-2 rounded-full bg-accent align-middle" /> Modified</th>}
            {showDelta && <th scope="col" className="px-4 py-2.5 font-medium">Difference</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line/60 last:border-0 hover:bg-raised/50">
              <th scope="row" className="px-4 py-2.5 font-normal text-muted">
                {r.label} {r.unit && <span className="text-faint">({r.unit})</span>}
                {r.note && <div className="text-[11px] text-faint">{r.note}</div>}
              </th>
              {showStock && <td className="px-4 py-2.5"><Value v={r.stock} digits={r.digits} range={r.stockRange} /></td>}
              {showMod && <td className="px-4 py-2.5"><Value v={r.modified} digits={r.digits} range={r.modifiedRange} /></td>}
              {showDelta && <td className="px-4 py-2.5"><Delta row={r} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-2 text-[11.5px] leading-4 text-faint">
        Small figures beside values are the indicative range from input uncertainty (verified ±2–3%, user ±5%, estimates wider).
        0–60 {result.conditions.rollout ? "uses" : "does not use"} 1-ft rollout.
      </p>
    </div>
  );
}

const TONE: Record<Finding["tone"], { icon: typeof Info; cls: string }> = {
  gain: { icon: TrendingUp, cls: "text-gain" },
  loss: { icon: TrendingDown, cls: "text-loss" },
  limit: { icon: AlertTriangle, cls: "text-caution" },
  info: { icon: Info, cls: "text-stock" },
  confidence: { icon: ShieldCheck, cls: "text-muted" },
};

function Findings({ findings }: { findings: Finding[] }) {
  return (
    <ul className="divide-y divide-line/70">
      {findings.map((f) => {
        const t = TONE[f.tone];
        const Icon = t.icon;
        return (
          <li key={f.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
            <Icon size={16} className={cx("mt-0.5 shrink-0", t.cls)} aria-hidden />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink">{f.title}</div>
              <p className="mt-0.5 text-[13px] leading-5 text-muted">{f.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function displayInput(key: SpecKey, value: unknown, units: UnitSystem) {
  if (value == null) return "—";
  if (Array.isArray(value)) return value.map((v) => Number(v).toFixed(2)).join(" / ");
  if (typeof value === "string") return value;
  const def = NUMERIC_FIELDS[key as NumericSpecKey];
  if (!def) return String(value);
  const d = toDisplay(def.quantity, value as number, units);
  return `${d.toFixed(def.quantity === "fraction" ? 1 : def.digits)} ${unitLabel(def.quantity, units)}`.trim();
}

function InputsTable({ result, units }: { result: AnalysisResult; units: UnitSystem }) {
  const scen: { r: ScenarioResult; label: string }[] = [{ r: result.stock, label: "Stock" }, ...(result.modified ? [{ r: result.modified, label: "Modified" }] : [])];
  const values = { stock: effectiveValues(result.config, "stock")!, modified: result.modified ? effectiveValues(result.config, "modified")! : null };
  const resolved = (r: ScenarioResult, key: SpecKey): { v: unknown; p: Provenance; note?: string } => {
    const sv = r.scenario === "stock" ? values.stock : values.modified!;
    const est = r.estimates.find((e) => e.key === key);
    if (sv[key].value != null) return { v: sv[key].value, p: r.provenance[key] ?? sv[key].provenance, note: sv[key].note ?? sv[key].source };
    if (est) return { v: est.value, p: "estimated", note: est.reason };
    return { v: null, p: "unavailable" };
  };
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[560px] text-left text-[12.5px]">
        <caption className="sr-only">Simulation inputs and their provenance</caption>
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">Input</th>
            {scen.map((s) => (
              <th key={s.label} scope="col" className="py-2 pr-3 font-medium">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SPEC_KEYS.map((key) => (
            <tr key={key} className="border-b border-line/50 last:border-0 align-top">
              <th scope="row" className="py-2 pr-3 font-normal text-muted">{SPEC_LABEL[key]}</th>
              {scen.map((s) => {
                const x = resolved(s.r, key);
                return (
                  <td key={s.label} className="py-2 pr-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="num text-ink">{displayInput(key, x.v, units)}</span>
                      <ProvenanceTag provenance={x.p} compact />
                    </div>
                    {x.note && <div className="mt-0.5 max-w-[34ch] text-[11px] leading-4 text-faint">{x.note}</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ResultsWorkspace() {
  const { state, dispatch, stale, running, runAnalysisNow, aiStatus, sendMessage } = useApp();
  const result = state.result?.analysis ?? null;
  const units = state.ui.units;
  const explanation = useMemo(() => (result ? explainAnalysis(result) : null), [result]);

  if (!result) {
    return (
      <div className="mx-auto max-w-xl py-10 text-center">
        <h2 className="text-lg font-semibold">No analysis yet</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Configure a vehicle in Manual Setup or with the AI Build Assistant, then run the analysis. Both modes feed this same workspace and the same physics engine.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button variant="primary" onClick={() => dispatch({ type: "setMode", mode: "manual" })}>Open Manual Setup</Button>
          <Button onClick={() => dispatch({ type: "setMode", mode: "assistant" })}>Open AI Build Assistant</Button>
          {state.config.stock && (
            <Button onClick={() => runAnalysisNow(true)} disabled={running}>
              {running ? <Spinner /> : null} Run with current inputs
            </Button>
          )}
        </div>
      </div>
    );
  }

  const view: ResultsView = result.modified ? state.ui.view : "stock";
  const stock = view === "modified" ? null : result.stock;
  const modified = view === "stock" ? null : result.modified;
  const focus = view === "stock" || !result.modified ? result.stock : result.modified;

  return (
    <div className="space-y-5">
      <div className="print-plain flex flex-wrap items-end justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <p className="text-xs text-faint">Analysis · {new Date(result.createdAt).toLocaleString()}</p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{vehicleLabel(result.identity)}</h1>
          <p className="mt-1 text-[13px] text-muted">
            {result.modified ? "Stock vs. Modified" : "Stock"} · {result.identity.sourceDetail}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Data quality — stock: <span className="text-ink">{result.stock.quality.level}</span>
              {result.modified && <> · modified: <span className="text-ink">{result.modified.quality.level}</span></>}
            </span>
            <span>
              {result.stock.quality.counts.verified} verified · {result.stock.quality.counts.user} user · {result.stock.quality.counts.estimated} estimated · {result.stock.quality.counts.unavailable} unavailable (key inputs)
            </span>
          </div>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          <Segmented
            label="Scenarios shown"
            value={view}
            onChange={(v) => dispatch({ type: "setView", view: v })}
            options={[
              { value: "stock", label: "Stock" },
              { value: "modified", label: "Modified", disabled: !result.modified },
              { value: "compare", label: "Compare", disabled: !result.modified },
            ]}
          />
        </div>
      </div>

      {stale && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" variant="primary" onClick={() => runAnalysisNow(true)} disabled={running}>
              {running ? <Spinner /> : <RefreshCw size={14} aria-hidden />} Re-run
            </Button>
          }
        >
          These results were computed for an earlier configuration. Inputs have changed since — re-run to update.
        </Notice>
      )}

      <MetricsTable result={result} view={view} units={units} />

      <div className="grid gap-4 xl:grid-cols-2">
        <SpeedTimeChart stock={stock} modified={modified} units={units} />
        <AccelChart stock={stock} modified={modified} units={units} />
        <CurveChart stock={stock} modified={modified} units={units} />
        <MassSweepChart stock={stock} modified={modified} units={units} />
      </div>
      <SensitivityChart result={focus} label={focus.scenario === "stock" ? "Stock" : "Modified"} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel
          title="Engineering analysis"
          subtitle="Generated deterministically from the computed results and model assumptions."
          actions={
            aiStatus === "available" && (
              <Button
                size="sm"
                className="no-print"
                onClick={() => {
                  dispatch({ type: "setMode", mode: "assistant" });
                  sendMessage(result.modified ? "Explain why the modified version accelerates differently." : "Explain these results and which assumptions matter most.");
                }}
              >
                <Sparkles size={14} aria-hidden /> Ask the assistant
              </Button>
            )
          }
        >
          {explanation && <Findings findings={explanation.findings} />}
        </Panel>
        <div className="space-y-4">
          {result.attribution && result.attribution.length > 0 && (
            <Panel title="What each change contributes" subtitle="Each group applied to stock alone.">
              <ul className="space-y-2 text-[13px]">
                {result.attribution.map((a) => (
                  <li key={a.group} className="flex items-baseline justify-between gap-3">
                    <span className="text-muted">{a.label}</span>
                    <span className="num text-ink">
                      {a.delta060 == null ? "n/a" : `${a.delta060 > 0 ? "+" : "−"}${Math.abs(a.delta060).toFixed(2)} s`} <span className="text-faint">0–60</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Model limitations">
            <ul className="list-disc space-y-1.5 pl-4 text-[12.5px] leading-5 text-muted">
              {explanation?.limitations.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </Panel>
        </div>
      </div>

      <Panel title="Inputs & provenance" subtitle="Every value used, where it came from, and which were estimated.">
        <InputsTable result={result} units={units} />
      </Panel>

      <div className="no-print flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs text-faint">Export</span>
        <Button size="sm" onClick={() => download(`${fileBase(result)}.json`, JSON.stringify(buildJsonReport(result, units), null, 2), "application/json")}>
          <FileJson size={14} aria-hidden /> JSON report
        </Button>
        <Button size="sm" onClick={() => download(`${fileBase(result)}-metrics.csv`, buildCsvReport(result, units), "text/csv")}>
          <Download size={14} aria-hidden /> Metrics CSV
        </Button>
        <Button size="sm" onClick={() => download(`${fileBase(result)}-trace.csv`, buildTraceCsv(result, units), "text/csv")}>
          <Download size={14} aria-hidden /> Speed trace CSV
        </Button>
        <Button size="sm" onClick={() => window.print()}>
          <Printer size={14} aria-hidden /> Print report
        </Button>
      </div>
    </div>
  );
}
