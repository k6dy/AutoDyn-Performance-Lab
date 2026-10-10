"use client";

import { Check, PencilLine, X } from "lucide-react";
import { useMemo, useState } from "react";
import { IssueList } from "@/components/manual/ManualSetup";
import LoadingStage from "@/components/LoadingStage";
import { Button, cx, Notice, ProvenanceTag } from "@/components/ui";
import { applyProposal, evaluateProposal, proposalVehicle } from "@/lib/ai/apply";
import type { ProposedChange } from "@/lib/ai/types";
import { NUMERIC_FIELDS, SPEC_LABEL, SURFACE_OPTIONS } from "@/lib/domain/fields";
import type { NumericSpecKey, SpecKey, SpecSet } from "@/lib/domain/types";
import { validateConfig } from "@/lib/domain/validation";
import { fromDisplay, toDisplay, unitLabel, type Quantity, type UnitSystem } from "@/lib/units";
import { customSpecSet, vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp } from "@/state/AppProvider";
import type { ProposalState } from "@/state/reducer";

const CONDITION_META: Record<string, { label: string; quantity?: Quantity }> = {
  claimedZeroTo60S: { label: "Claimed 0–60 mph", quantity: "time" },
  claimedTopSpeedMs: { label: "Claimed top speed", quantity: "speed" },
  ambientTempC: { label: "Air temperature", quantity: "temperature" },
  elevationM: { label: "Elevation", quantity: "elevation" },
  surface: { label: "Road surface" },
};

function meta(change: ProposedChange) {
  if (change.target === "conditions" || CONDITION_META[change.key]) return CONDITION_META[change.key] ?? { label: change.key };
  const def = NUMERIC_FIELDS[change.key as NumericSpecKey];
  return { label: SPEC_LABEL[change.key as SpecKey] ?? change.key, quantity: def?.quantity };
}

function show(value: number | string | null, quantity: Quantity | undefined, units: UnitSystem) {
  if (value == null) return "not set";
  if (typeof value === "string") return SURFACE_OPTIONS.find((s) => s.value === value)?.label ?? value;
  if (!quantity) return String(value);
  const d = toDisplay(quantity, value, units);
  const digits = quantity === "fraction" ? 1 : quantity === "coefficient" ? 3 : quantity === "ratio" || quantity === "time" ? 2 : 0;
  return `${d.toFixed(digits)} ${unitLabel(quantity, units)}`.trim();
}

const issueKey = (i: { scenario: string; key?: string; message: string }) => `${i.scenario}|${i.key}|${i.message}`;

export default function ProposalPanel({ ps }: { ps: ProposalState }) {
  const { state, dispatch } = useApp();
  const [editing, setEditing] = useState(false);
  const [ack, setAck] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const { proposal } = ps;
  const units = state.ui.units;
  const pending = ps.status === "pending";

  const evaluation = useMemo(() => evaluateProposal(state.config, proposal, { chosen: ps.chosen, edits: ps.edits }), [state.config, proposal, ps.chosen, ps.edits]);
  const preview = useMemo(() => applyProposal(state.config, proposal, ps), [state.config, proposal, ps]);
  const vehicle = proposalVehicle(proposal, ps.chosen);
  const needsChoice = proposal.vehicle?.kind === "choose" && !ps.chosen;
  const identifyOnly = proposal.vehicle?.kind === "identify" || proposal.vehicle?.kind === "not_found";

  // Only issues introduced by this proposal block it; pre-existing ones are shown in Manual Setup.
  const before = useMemo(() => new Set(validateConfig(state.config).issues.map(issueKey)), [state.config]);
  const after = useMemo(() => validateConfig(preview.config), [preview.config]);
  const newIssues = after.issues.filter((i) => !before.has(issueKey(i)) && !(i.scenario === "stock" && i.key === undefined && !preview.config.stock));
  const newErrors = newIssues.filter((i) => i.severity === "error");
  const newWarnings = newIssues.filter((i) => i.severity === "warning");
  const selectedCount = proposal.changes.filter((c) => ps.selected[c.id]).length;
  const nothingToApply = !vehicle && selectedCount === 0;
  const valid = pending && !needsChoice && !nothingToApply && newErrors.length === 0 && (newWarnings.length === 0 || ack);

  const choose = async (trimId: string) => {
    setChoosing(trimId);
    setChooseError(null);
    try {
      const res = await fetch(`/api/vehicles/spec?trimId=${encodeURIComponent(trimId)}`, { signal: AbortSignal.timeout(12000) });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not load that trim.");
      dispatch({ type: "proposalChoose", proposalId: proposal.id, specSet: body.specSet as SpecSet });
    } catch (e) {
      setChooseError((e as Error).name === "TimeoutError" ? "Loading that trim timed out. Try again." : (e as Error).message);
    } finally {
      setChoosing(null);
    }
  };

  /** Applies the approved values to the shared configuration (explicit user action). */
  const commit = (then: "run" | "manual") => {
    const { config } = applyProposal(state.config, proposal, ps);
    dispatch({ type: "proposalApplied", proposalId: proposal.id, config, baseline: vehicle, view: proposal.view ?? (config.modified ? "compare" : null) });
    if (then === "run" && config.stock && validateConfig(config).errors === 0) dispatch({ type: "requestRun", navigate: false, source: "assistant" });
    if (then === "manual") dispatch({ type: "setMode", mode: "manual" });
  };

  const enterManually = () => {
    const v = proposal.vehicle;
    const specSet = v && "specSet" in v ? v.specSet : customSpecSet(v?.label ?? "Custom vehicle", null);
    dispatch({ type: "proposalApplied", proposalId: proposal.id, config: { stock: specSet, modified: null, conditions: state.config.conditions }, baseline: specSet, view: null });
    dispatch({ type: "setMode", mode: "manual" });
  };

  return (
    <section aria-label="Review changes" className={cx("animate-enter rounded-lg border bg-surface", pending ? "border-accent/45" : "border-line opacity-90")}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[14px] font-semibold">Review changes</h3>
        <span className={cx("text-[11px] font-medium tracking-wide uppercase", pending ? "text-accent" : ps.status === "applied" ? "text-success" : "text-faint")}>
          {ps.status === "pending" ? "Needs your approval" : ps.status}
        </span>
      </header>

      <div className="space-y-3 px-4 py-3 text-[13px]">
        {proposal.vehicle && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted">Vehicle</div>
            {proposal.vehicle.kind === "load" && (
              <div>
                <div className="font-medium text-ink">{proposal.vehicle.label}</div>
                <p className="mt-0.5 text-xs leading-4 text-muted">{proposal.vehicle.note} Specifications come from the dataset, not the AI.</p>
              </div>
            )}
            {identifyOnly && (
              <div>
                <div className="font-medium text-ink">{proposal.vehicle.label}</div>
                <p className="mt-0.5 text-xs leading-4 text-warning">{proposal.vehicle.note}</p>
              </div>
            )}
            {proposal.vehicle.kind === "choose" && (
              <fieldset disabled={!pending} className="space-y-1.5">
                <legend className="mb-1 text-xs leading-4 text-muted">{proposal.vehicle.note}</legend>
                {proposal.vehicle.candidates.map((c) => {
                  const selected = ps.chosen?.identity.datasetTrimId === c.trimId;
                  return (
                    <button
                      key={c.trimId}
                      type="button"
                      onClick={() => choose(c.trimId)}
                      aria-pressed={selected}
                      className={cx(
                        "flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors",
                        selected ? "border-accent bg-accent-soft text-ink" : "border-line text-muted hover:border-line-strong hover:text-ink",
                      )}
                    >
                      <span className="min-w-0">{c.label}</span>
                      {selected && <Check size={14} className="shrink-0 text-accent" aria-hidden />}
                    </button>
                  );
                })}
                {choosing && <LoadingStage make={proposal.vehicle.make} label="Loading verified specifications" compact />}
                {chooseError && <p className="text-xs text-error">{chooseError}</p>}
              </fieldset>
            )}
            {vehicle && state.config.stock && pending && (
              <p className="text-xs leading-4 text-warning">
                Replaces {vehicleLabel(state.config.stock.identity)}
                {state.config.modified ? " and clears its modified scenario." : "."}
              </p>
            )}
          </div>
        )}

        {proposal.changes.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">Values that will change</div>
            <ul className="space-y-2">
              {evaluation.rows.map((row) => {
                const c = row.change;
                const m = meta(c);
                const checked = !!ps.selected[c.id];
                const editable = editing && pending && typeof row.to === "number" && m.quantity;
                return (
                  <li key={c.id} className={cx("rounded-md border px-2.5 py-2", checked ? "border-line-strong bg-raised" : "border-line")}>
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!pending || !!row.error}
                        onChange={() => dispatch({ type: "proposalToggle", proposalId: proposal.id, changeId: c.id })}
                        className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-ink">{m.label}</span>
                          <span className="text-[11px] text-faint">{c.target === "conditions" ? "Conditions" : c.target === "modified" ? "Modified" : "Stock"}</span>
                          <ProvenanceTag provenance="user" title="User-provided assumption" />
                        </span>
                        <span className="num mt-0.5 block text-[13px] text-muted">
                          {show(row.from, m.quantity, units)} → <span className={c.target === "modified" ? "text-modified" : c.target === "stock" ? "text-stock" : "text-ink"}>{row.to == null ? "—" : show(row.to, m.quantity, units)}</span>
                          <span className="ml-1 text-xs text-faint">({c.display})</span>
                        </span>
                        {!c.statedByUser && <span className="mt-0.5 block text-[11.5px] text-warning">You didn&apos;t state this number — check it before applying.</span>}
                        {row.error && <span className="mt-0.5 block text-[11.5px] text-error">{row.error}</span>}
                      </span>
                    </label>
                    {editable && (
                      <div className="mt-2 flex items-center gap-2 pl-6">
                        <label htmlFor={`edit-${c.id}`} className="text-[11px] text-faint">
                          New value
                        </label>
                        <input
                          id={`edit-${c.id}`}
                          inputMode="decimal"
                          defaultValue={Number(toDisplay(m.quantity!, row.to as number, units).toFixed(3))}
                          onBlur={(e) => {
                            const n = Number(e.target.value);
                            dispatch({
                              type: "proposalEdit",
                              proposalId: proposal.id,
                              changeId: c.id,
                              value: e.target.value.trim() && Number.isFinite(n) ? fromDisplay(m.quantity!, n, units) : undefined,
                            });
                          }}
                          className="num h-9 w-28 rounded-md border border-line bg-bg px-2 text-[13px]"
                        />
                        <span className="text-[11px] text-faint">{unitLabel(m.quantity!, units)}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {pending && (
              <button type="button" onClick={() => setEditing((v) => !v)} className="mt-2 text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-ink">
                {editing ? "Done adjusting" : "Adjust values"}
              </button>
            )}
          </div>
        )}

        {proposal.rejected.length > 0 && (
          <div className="text-xs leading-4">
            <div className="mb-1 font-medium text-muted">Not included</div>
            <ul className="space-y-1 text-faint">
              {proposal.rejected.map((r, i) => (
                <li key={i}>
                  {r.text} — <span className="text-warning">{r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {pending && newIssues.length > 0 && (
          <div className="space-y-2 rounded-md border border-line bg-bg/60 px-3 py-2">
            <div className="text-xs font-medium text-muted">Validation</div>
            <IssueList issues={newIssues} actions={false} />
            {newErrors.length > 0 && <p className="text-xs text-error">Adjust the values or cancel — invalid inputs can&apos;t be applied.</p>}
            {newErrors.length === 0 && newWarnings.length > 0 && (
              <label className="flex items-start gap-2 text-xs text-[#f1d39e]">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
                Apply these unusual values anyway.
              </label>
            )}
          </div>
        )}

        {pending && identifyOnly ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={enterManually}>
              <PencilLine size={14} aria-hidden /> Enter specifications manually
            </Button>
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "proposalCancel", proposalId: proposal.id })}>
              <X size={14} aria-hidden /> Cancel
            </Button>
          </div>
        ) : pending ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={() => commit("run")} disabled={!valid}>
              <Check size={14} aria-hidden /> Apply to Simulation
            </Button>
            <Button size="sm" onClick={() => commit("manual")} disabled={!valid}>
              <PencilLine size={14} aria-hidden /> Edit Manually
            </Button>
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "proposalCancel", proposalId: proposal.id })}>
              <X size={14} aria-hidden /> Cancel
            </Button>
          </div>
        ) : ps.status === "applied" ? (
          <Notice tone="success">Applied to the shared configuration.</Notice>
        ) : null}
        {pending && !identifyOnly && (
          <p className="text-[11.5px] leading-4 text-faint">Apply runs the physics engine with these values. Edit Manually applies them and opens Manual Setup instead.</p>
        )}
      </div>
    </section>
  );
}
