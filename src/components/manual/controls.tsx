"use client";

import { Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cx, ProvenanceTag } from "@/components/ui";
import { NUMERIC_FIELDS, type NumericFieldDef } from "@/lib/domain/fields";
import { effectiveValues, sameValue } from "@/lib/domain/scenario";
import type { EnumSpecKey, NumericSpecKey, Provenance, ScenarioId, SpecKey, SpecValue, SpecValues } from "@/lib/domain/types";
import type { Issue } from "@/lib/domain/validation";
import { resolveInputs, type EstimateNote } from "@/lib/physics/resolve";
import { fromDisplay, toDisplay, unitLabel, type UnitSystem } from "@/lib/units";
import { useApp } from "@/state/AppProvider";

export const inputClass =
  "num h-10 w-full min-w-0 rounded-md border bg-bg px-3 text-[15px] text-ink transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent sm:h-9 sm:text-sm";

export function formatDisplay(def: NumericFieldDef, si: number | null, units: UnitSystem) {
  if (si == null) return "";
  const d = toDisplay(def.quantity, si, units);
  const digits = def.quantity === "fraction" ? 1 : def.quantity === "radius" && units === "metric" ? 0 : def.digits;
  return String(Number(d.toFixed(digits)));
}

/**
 * Parses user text into SI. Percent fields accept either "86" or "0.86" (values ≤ 1 are read as a
 * fraction), which prevents a common 100× entry mistake. Returns undefined for unparseable text.
 */
export function parseDisplay(def: NumericFieldDef, text: string, units: UnitSystem): number | null | undefined {
  const t = text.trim().replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined;
  if (def.quantity === "fraction" && n > 0 && n <= 1) return n;
  return fromDisplay(def.quantity, n, units);
}

/** Text input that commits on blur / Enter, so typing never thrashes results or validation. */
export function CommitInput({
  id,
  value,
  placeholder,
  invalid,
  onCommit,
  inputMode = "decimal",
  className,
  ariaDescribedBy,
  ariaLabel,
}: {
  id: string;
  value: string;
  placeholder?: string;
  invalid?: boolean;
  onCommit: (text: string) => void;
  inputMode?: "decimal" | "text" | "numeric";
  className?: string;
  ariaDescribedBy?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      id={id}
      inputMode={inputMode}
      autoComplete="off"
      value={draft ?? value}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      aria-describedby={ariaDescribedBy}
      aria-label={ariaLabel}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={cx(inputClass, invalid ? "border-error/70" : "border-line", className)}
    />
  );
}

export type RowProps = {
  label: string;
  htmlFor: string;
  provenance?: Provenance;
  provenanceTitle?: string;
  unit?: string;
  hint?: ReactNode;
  help?: string;
  compare?: ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  issue?: Issue;
  children: ReactNode;
};

export function Row({ label, htmlFor, provenance, provenanceTitle, unit, hint, help, compare, onReset, resetLabel, issue, children }: RowProps) {
  const hintId = `${htmlFor}-hint`;
  return (
    <div className="min-w-0" data-field={htmlFor}>
      <div className="mb-1 flex min-h-[18px] items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="truncate text-[13px] font-medium text-muted">
          {label}
        </label>
        {provenance && <ProvenanceTag provenance={provenance} title={provenanceTitle} />}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          {children}
          {unit && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-faint">{unit}</span>}
        </div>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            title={resetLabel}
            aria-label={`${resetLabel}: ${label}`}
            className="grid h-10 w-9 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-raised hover:text-ink sm:h-9 sm:w-8"
          >
            <Undo2 size={14} aria-hidden />
          </button>
        )}
      </div>
      <div id={hintId} className="mt-1 space-y-0.5 text-[12px] leading-4">
        {compare && <div className="text-stock">{compare}</div>}
        {issue && (
          <div className={issue.severity === "error" ? "text-error" : "text-warning"}>
            {issue.severity === "error" ? "Invalid: " : "Unusual: "}
            {issue.message}
            {onReset && issue.severity === "error" && (
              <button type="button" onClick={onReset} className="ml-1 underline decoration-dotted underline-offset-2 hover:text-ink">
                {resetLabel}
              </button>
            )}
          </div>
        )}
        {hint && <div className="text-faint">{hint}</div>}
        {help && <div className="text-faint/80">{help}</div>}
      </div>
    </div>
  );
}

/** Per-field helpers bound to the scenario being edited. */
export function useFieldBinding(scenario: ScenarioId) {
  const { state, dispatch } = useApp();
  const { config, baseline } = state;
  const values = effectiveValues(config, scenario)!;
  const stockValues = config.stock!.values;

  const estimates = useMemo(() => {
    const r = resolveInputs(values, config.conditions, config.stock!.identity);
    const map = new Map<string, EstimateNote>();
    if (r.ok) for (const e of r.estimates) map.set(e.key, e);
    return map;
  }, [values, config.conditions, config.stock]);

  const set = (key: SpecKey, value: SpecValue<unknown>["value"], note?: string) => {
    const v = {
      value,
      provenance: value == null ? "unavailable" : "user",
      source: value == null ? undefined : scenario === "modified" ? "User-provided assumption" : "User input",
      note,
    } as SpecValues[SpecKey];
    if (scenario === "stock") dispatch({ type: "setStockValue", key, value: v });
    else dispatch({ type: "setModifiedValue", key, value: v });
  };

  const resetInfo = (key: SpecKey): { onReset?: () => void; resetLabel?: string } => {
    if (scenario === "modified") {
      if (!config.modified?.overrides[key] || sameValue(values[key].value, stockValues[key].value)) return {};
      return { onReset: () => dispatch({ type: "resetField", scenario: "modified", key }), resetLabel: "Use stock value" };
    }
    const original = baseline?.values[key];
    if (!original || (sameValue(original.value, values[key].value) && original.provenance === values[key].provenance)) return {};
    return {
      onReset: () => dispatch({ type: "resetField", scenario: "stock", key }),
      resetLabel: original.value == null ? "Use AutoDyn default" : "Restore source value",
    };
  };

  const provenanceOf = (key: SpecKey): Provenance =>
    values[key].value == null ? (estimates.has(key) ? "estimated" : "unavailable") : values[key].provenance;

  return { values, stockValues, estimates, set, resetInfo, provenanceOf, units: state.ui.units, scenario };
}

export type Binding = ReturnType<typeof useFieldBinding>;

export function NumericField({ b, k, issue, label, showHelp = true, compact }: { b: Binding; k: NumericSpecKey; issue?: Issue; label?: string; showHelp?: boolean; compact?: boolean }) {
  const def = NUMERIC_FIELDS[k];
  const v = b.values[k];
  const est = b.estimates.get(k);
  const unit = unitLabel(def.quantity, b.units);
  const isEv = b.values.powertrain.value === "ev";
  const diff = b.scenario === "modified" && !sameValue(v.value, b.stockValues[k].value);
  const stockText = b.stockValues[k].value != null ? `${formatDisplay(def, b.stockValues[k].value, b.units)} ${unit}` : "auto";
  let hint: ReactNode = null;
  if (v.value == null) {
    hint = est
      ? `AutoDyn default: ${formatDisplay(def, est.value as number, b.units)} ${unit} — ${est.reason}`
      : def.required
        ? "Required — not available from the data source."
        : null;
  } else if (v.provenance === "estimated") hint = `Estimate: ${v.note ?? "model assumption"}`;
  else if (v.provenance === "verified") hint = v.source;
  else if (v.note) hint = v.note;
  return (
    <Row
      label={label ?? (isEv && def.evLabel ? def.evLabel : def.label)}
      htmlFor={`f-${k}`}
      provenance={b.provenanceOf(k)}
      provenanceTitle={v.source ?? est?.reason}
      unit={unit}
      hint={hint}
      help={showHelp && !compact ? def.help : undefined}
      issue={issue}
      compare={diff ? `Stock: ${stockText}` : undefined}
      {...b.resetInfo(k)}
    >
      <CommitInput
        id={`f-${k}`}
        ariaDescribedBy={`f-${k}-hint`}
        value={formatDisplay(def, v.value, b.units)}
        placeholder={est ? `≈ ${formatDisplay(def, est.value as number, b.units)}` : def.required ? "Required" : ""}
        invalid={issue?.severity === "error"}
        className="pr-14"
        onCommit={(text) => {
          const si = parseDisplay(def, text, b.units);
          if (si !== undefined) b.set(k, si);
        }}
      />
    </Row>
  );
}

export function SelectField<K extends EnumSpecKey>({
  b,
  k,
  label,
  options,
  issue,
  help,
}: {
  b: Binding;
  k: K;
  label: string;
  options: { value: string; label: string }[];
  issue?: Issue;
  help?: string;
}) {
  const v = b.values[k];
  const est = b.estimates.get(k);
  const diff = b.scenario === "modified" && !sameValue(v.value, b.stockValues[k].value);
  return (
    <Row
      label={label}
      htmlFor={`f-${k}`}
      provenance={b.provenanceOf(k)}
      provenanceTitle={v.source ?? est?.reason}
      hint={v.value == null ? (est ? `AutoDyn default: ${options.find((o) => o.value === est.value)?.label ?? est.value} — ${est.reason}` : null) : v.provenance === "verified" ? null : v.note}
      help={help}
      issue={issue}
      compare={diff ? `Stock: ${options.find((o) => o.value === b.stockValues[k].value)?.label ?? "not set"}` : undefined}
      {...b.resetInfo(k)}
    >
      <select id={`f-${k}`} value={(v.value as string | null) ?? ""} onChange={(e) => b.set(k, e.target.value || null)} className={cx(inputClass, "border-line font-sans")}>
        <option value="">{est ? "AutoDyn default" : "Not set"}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}
