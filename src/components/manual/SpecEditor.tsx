"use client";

import { ChevronDown, Undo2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cx, ProvenanceTag } from "@/components/ui";
import {
  ASPIRATION_OPTIONS,
  DRIVETRAIN_OPTIONS,
  NUMERIC_FIELDS,
  POWERTRAIN_OPTIONS,
  SURFACE_OPTIONS,
  TRANSMISSION_OPTIONS,
  type NumericFieldDef,
} from "@/lib/domain/fields";
import { effectiveValues, sameValue } from "@/lib/domain/scenario";
import type { EnumSpecKey, NumericSpecKey, Provenance, SpecKey, SpecValue, SpecValues } from "@/lib/domain/types";
import type { Issue } from "@/lib/domain/validation";
import { resolveInputs, type EstimateNote } from "@/lib/physics/resolve";
import { fromDisplay, tireSizeToRadiusM, toDisplay, unitLabel, type UnitSystem } from "@/lib/units";
import { useApp } from "@/state/AppProvider";

const inputClass =
  "num h-9 w-full min-w-0 rounded-md border bg-bg px-2.5 text-sm text-ink transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent";

function formatDisplay(def: NumericFieldDef, si: number | null, units: UnitSystem) {
  if (si == null) return "";
  const d = toDisplay(def.quantity, si, units);
  const digits = def.quantity === "fraction" ? 1 : def.quantity === "radius" && units === "metric" ? 0 : def.digits;
  return String(Number(d.toFixed(digits)));
}

/** Text input that commits on blur / Enter, so typing never thrashes results or validation. */
function CommitInput({
  id,
  value,
  placeholder,
  invalid,
  onCommit,
  inputMode = "decimal",
  className,
  ariaDescribedBy,
}: {
  id: string;
  value: string;
  placeholder?: string;
  invalid?: boolean;
  onCommit: (text: string) => void;
  inputMode?: "decimal" | "text" | "numeric";
  className?: string;
  ariaDescribedBy?: string;
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
      className={cx(inputClass, invalid ? "border-loss/70" : "border-line", className)}
    />
  );
}

type RowProps = {
  label: string;
  htmlFor: string;
  provenance: Provenance;
  provenanceTitle?: string;
  unit?: string;
  hint?: ReactNode;
  compare?: ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  issue?: Issue;
  children: ReactNode;
};

function Row({ label, htmlFor, provenance, provenanceTitle, unit, hint, compare, onReset, resetLabel, issue, children }: RowProps) {
  const hintId = `${htmlFor}-hint`;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex min-h-[18px] items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="truncate text-xs font-medium text-muted">
          {label}
        </label>
        <ProvenanceTag provenance={provenance} title={provenanceTitle} />
      </div>
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          {children}
          {unit && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-faint">{unit}</span>}
        </div>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            title={resetLabel}
            aria-label={resetLabel}
            className="grid h-9 w-8 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-raised hover:text-ink"
          >
            <Undo2 size={14} aria-hidden />
          </button>
        )}
      </div>
      <div id={hintId} className="mt-1 space-y-0.5 text-[11.5px] leading-4">
        {compare && <div className="text-accent">{compare}</div>}
        {issue && <div className={issue.severity === "error" ? "text-loss" : "text-caution"}>{issue.message}</div>}
        {hint && <div className="text-faint">{hint}</div>}
      </div>
    </div>
  );
}

function Section({ title, note, children, advanced }: { title: string; note?: string; children: ReactNode; advanced?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
        <h3 className="text-[14px] font-semibold tracking-tight">{title}</h3>
        {note && <p className="text-xs text-faint">{note}</p>}
      </header>
      <div className="grid gap-x-4 gap-y-4 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-3">{children}</div>
      {advanced && (
        <div className="border-t border-line">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] font-medium text-muted transition-colors hover:text-ink sm:px-5"
          >
            Advanced parameters
            <ChevronDown size={16} aria-hidden className={cx("transition-transform duration-200", open && "rotate-180")} />
          </button>
          {open && <div className="animate-enter grid gap-x-4 gap-y-4 px-4 pb-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-3">{advanced}</div>}
        </div>
      )}
    </section>
  );
}

export default function SpecEditor({ issues }: { issues: Issue[] }) {
  const { state, dispatch } = useApp();
  const { config, baseline, ui } = state;
  const scenario = ui.editing;
  const units = ui.units;
  const values = effectiveValues(config, scenario)!;
  const stockValues = config.stock!.values;
  const isEv = values.powertrain.value === "ev";

  const estimates = useMemo(() => {
    const r = resolveInputs(values, config.conditions, config.stock!.identity);
    const map = new Map<string, EstimateNote>();
    if (r.ok) for (const e of r.estimates) map.set(e.key, e);
    return map;
  }, [values, config.conditions, config.stock]);

  const issueFor = (key: string) => issues.find((i) => i.key === key && (i.scenario === scenario || i.scenario === "conditions"));

  const set = (key: SpecKey, value: SpecValue<unknown>["value"], note?: string) => {
    const v = { value, provenance: value == null ? "unavailable" : "user", source: value == null ? undefined : scenario === "modified" ? "User-provided assumption" : "User input", note } as SpecValues[SpecKey];
    dispatch({ type: scenario === "stock" ? "setStockValue" : "setModifiedValue", key, value: v });
  };

  const resetInfo = (key: SpecKey) => {
    if (scenario === "modified") {
      if (!config.modified?.overrides[key] || sameValue(values[key].value, stockValues[key].value)) return {};
      return { onReset: () => dispatch({ type: "resetField", scenario: "modified", key }), resetLabel: "Reset to stock value" };
    }
    const original = baseline?.values[key];
    if (!original || (sameValue(original.value, values[key].value) && original.provenance === values[key].provenance)) return {};
    return { onReset: () => dispatch({ type: "resetField", scenario: "stock", key }), resetLabel: "Restore source value" };
  };

  const provenanceOf = (key: SpecKey): Provenance => (values[key].value == null ? (estimates.has(key) ? "estimated" : "unavailable") : values[key].provenance);

  const numeric = (key: NumericSpecKey) => {
    const def = NUMERIC_FIELDS[key];
    const v = values[key];
    const est = estimates.get(key);
    const unit = unitLabel(def.quantity, units);
    const label = isEv && def.evLabel ? def.evLabel : def.label;
    const diff = scenario === "modified" && !sameValue(v.value, stockValues[key].value);
    const stockText = stockValues[key].value != null ? `${formatDisplay(def, stockValues[key].value, units)} ${unit}` : "auto";
    let hint: ReactNode = null;
    if (v.value == null) {
      hint = est
        ? `Auto-estimate: ${formatDisplay(def, est.value as number, units)} ${unit} — ${est.reason}`
        : def.required
          ? "Required — not available from the data source."
          : def.estimable
            ? "Estimated automatically."
            : null;
    } else if (v.provenance === "estimated") {
      hint = v.note ?? "Estimated value";
    } else if (v.provenance === "verified") {
      hint = v.source;
    } else if (v.note) {
      hint = v.note;
    }
    return (
      <Row
        key={key}
        label={label}
        htmlFor={`f-${key}`}
        provenance={provenanceOf(key)}
        provenanceTitle={v.source ?? est?.reason}
        unit={unit}
        hint={hint}
        issue={issueFor(key)}
        compare={diff ? `Stock: ${stockText}` : undefined}
        {...resetInfo(key)}
      >
        <CommitInput
          id={`f-${key}`}
          ariaDescribedBy={`f-${key}-hint`}
          value={formatDisplay(def, v.value, units)}
          placeholder={est ? `≈ ${formatDisplay(def, est.value as number, units)}` : def.required ? "Required" : ""}
          invalid={issueFor(key)?.severity === "error"}
          className="pr-12"
          onCommit={(text) => {
            const t = text.trim().replace(/,/g, "");
            if (!t) return set(key, null);
            const n = Number(t);
            if (!Number.isFinite(n)) return;
            set(key, fromDisplay(def.quantity, n, units));
          }}
        />
      </Row>
    );
  };

  const select = <K extends EnumSpecKey>(key: K, label: string, options: { value: string; label: string }[]) => {
    const v = values[key];
    const est = estimates.get(key);
    const diff = scenario === "modified" && !sameValue(v.value, stockValues[key].value);
    return (
      <Row
        key={key}
        label={label}
        htmlFor={`f-${key}`}
        provenance={provenanceOf(key)}
        provenanceTitle={v.source ?? est?.reason}
        hint={v.value == null ? (est ? `Assumed: ${options.find((o) => o.value === est.value)?.label ?? est.value} — ${est.reason}` : null) : v.provenance === "verified" ? v.source : v.note}
        issue={issueFor(key)}
        compare={diff ? `Stock: ${options.find((o) => o.value === stockValues[key].value)?.label ?? "not set"}` : undefined}
        {...resetInfo(key)}
      >
        <select
          id={`f-${key}`}
          value={(v.value as string | null) ?? ""}
          onChange={(e) => set(key, e.target.value || null)}
          className={cx(inputClass, "border-line font-sans")}
        >
          <option value="">{est ? "Auto" : "Not set"}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
    );
  };

  const gearRow = () => {
    const v = values.gearRatios;
    const est = estimates.get("gearRatios");
    const text = v.value ? v.value.map((r) => r.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")).join(" / ") : "";
    return (
      <Row
        key="gearRatios"
        label="Gear ratios (first → top)"
        htmlFor="f-gearRatios"
        provenance={provenanceOf("gearRatios")}
        hint={v.value == null && est ? `Auto-estimate: ${(est.value as number[]).join(" / ")} — ${est.reason}` : v.note}
        issue={issueFor("gearRatios")}
        compare={scenario === "modified" && !sameValue(v.value, stockValues.gearRatios.value) ? `Stock: ${stockValues.gearRatios.value?.join(" / ") ?? "auto"}` : undefined}
        {...resetInfo("gearRatios")}
      >
        <CommitInput
          id="f-gearRatios"
          inputMode="text"
          value={text}
          placeholder="e.g. 4.38 / 2.86 / 1.92 / 1.37 / 1.00 / 0.82 / 0.73"
          invalid={issueFor("gearRatios")?.severity === "error"}
          onCommit={(t) => {
            const parts = t.split(/[\s/,;]+/).filter(Boolean).map(Number);
            if (!t.trim()) return set("gearRatios", null);
            if (parts.some((n) => !Number.isFinite(n))) return;
            set("gearRatios", parts);
          }}
        />
      </Row>
    );
  };

  const tireSizeRow = () => (
    <Row key="tireSize" label="Tire size helper" htmlFor="f-tireSize" provenance="user" hint="Enter a size like 225/45R17 to set the rolling radius.">
      <CommitInput
        id="f-tireSize"
        inputMode="text"
        value=""
        placeholder="225/45R17"
        onCommit={(t) => {
          const r = tireSizeToRadiusM(t);
          if (r) set("tireRadiusM", Number(r.toFixed(4)), `From tire size ${t.toUpperCase()}`);
        }}
      />
    </Row>
  );

  const c = config.conditions;
  const condIssue = (k: string) => issues.find((i) => i.scenario === "conditions" && i.key === k);

  return (
    <div className="space-y-4">
      <Section
        title="Powertrain"
        note={scenario === "modified" ? "Editing the Modified scenario — stock values stay unchanged." : undefined}
        advanced={
          <>
            {!isEv && numeric("peakPowerRpm")}
            {!isEv && numeric("peakTorqueRpm")}
            {numeric("redlineRpm")}
            {!isEv && values.transmission.value !== "cvt" && numeric("gearCount")}
            {!isEv && values.transmission.value !== "cvt" && gearRow()}
            {numeric("finalDrive")}
            {!isEv && values.transmission.value !== "cvt" && numeric("shiftTimeS")}
          </>
        }
      >
        {select("powertrain", "Powertrain type", POWERTRAIN_OPTIONS)}
        {!isEv && select("aspiration", "Induction", ASPIRATION_OPTIONS.filter((o) => o.value !== "electric"))}
        {numeric("peakPowerKw")}
        {numeric("peakTorqueNm")}
        {select("drivetrain", "Drivetrain", DRIVETRAIN_OPTIONS)}
        {!isEv && select("transmission", "Transmission", TRANSMISSION_OPTIONS.filter((o) => o.value !== "direct"))}
      </Section>

      <Section
        title="Vehicle"
        advanced={
          <>
            {numeric("tireRadiusM")}
            {tireSizeRow()}
            {numeric("rollingResistance")}
            {numeric("frontWeightFraction")}
            {numeric("cgHeightRatio")}
          </>
        }
      >
        {numeric("curbMassKg")}
        {numeric("payloadKg")}
        {numeric("dragCoefficient")}
        {numeric("frontalAreaM2")}
        {numeric("drivetrainEfficiency")}
        {numeric("tireMu")}
      </Section>

      <section className="rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
          <h3 className="text-[14px] font-semibold tracking-tight">Conditions</h3>
          <p className="text-xs text-faint">Shared by both scenarios so the comparison stays fair.</p>
        </header>
        <div className="grid gap-x-4 gap-y-4 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-4">
          <Row label="Ambient temperature" htmlFor="c-temp" provenance="user" unit={unitLabel("temperature", units)} issue={condIssue("ambientTempC")} hint="Rated power assumed at 25 °C, sea level.">
            <CommitInput
              id="c-temp"
              value={String(Math.round(toDisplay("temperature", c.ambientTempC, units)))}
              className="pr-10"
              onCommit={(t) => {
                const n = Number(t);
                if (t.trim() && Number.isFinite(n)) dispatch({ type: "setConditions", patch: { ambientTempC: fromDisplay("temperature", n, units) } });
              }}
            />
          </Row>
          <Row label="Elevation" htmlFor="c-elev" provenance="user" unit={unitLabel("elevation", units)} issue={condIssue("elevationM")} hint="Sets air density and naturally aspirated power loss.">
            <CommitInput
              id="c-elev"
              value={String(Math.round(toDisplay("elevation", c.elevationM, units)))}
              className="pr-10"
              onCommit={(t) => {
                const n = Number(t);
                if (t.trim() && Number.isFinite(n)) dispatch({ type: "setConditions", patch: { elevationM: fromDisplay("elevation", n, units) } });
              }}
            />
          </Row>
          <Row label="Road surface" htmlFor="c-surface" provenance="user" hint={`Friction × ${SURFACE_OPTIONS.find((s) => s.value === c.surface)?.factor}`}>
            <select
              id="c-surface"
              value={c.surface}
              onChange={(e) => dispatch({ type: "setConditions", patch: { surface: e.target.value as typeof c.surface } })}
              className={cx(inputClass, "border-line font-sans")}
            >
              {SURFACE_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </Row>
          <div className="flex items-start gap-2.5 pt-6">
            <input
              id="c-rollout"
              type="checkbox"
              checked={c.rollout}
              onChange={(e) => dispatch({ type: "setConditions", patch: { rollout: e.target.checked } })}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <label htmlFor="c-rollout" className="text-xs leading-5 text-muted">
              Subtract 1-ft rollout from 0–60 (US magazine convention)
            </label>
          </div>
        </div>
      </section>
    </div>
  );
}
