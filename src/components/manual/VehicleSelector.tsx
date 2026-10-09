"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LoadingStage, { BrandGlyph, preloadBrandMarks } from "@/components/LoadingStage";
import { Button, cx, Notice, ProvenanceTag, Segmented } from "@/components/ui";
import type { SpecSet } from "@/lib/domain/types";
import { DATASET_YEARS, hasDatasetSpecs, selectableYears } from "@/lib/vehicles/catalog";
import { customSpecSet, identityOnlySpecSet, vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp } from "@/state/AppProvider";

type Source = "lookup" | "vin" | "custom";
type TrimOption = { id: string; label: string; detail: string; complete: boolean };
type Level = "makes" | "models" | "trims" | "spec" | "vin";
type Loadable<T> = { status: "idle" | "loading" | "ready" | "error"; data: T; error?: string };

const idle = <T,>(data: T): Loadable<T> => ({ status: "idle", data });
export const REQUEST_TIMEOUT_MS = 12000;

class TimeoutError extends Error {}

function anySignal(signals: AbortSignal[]) {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) c.abort();
    else s.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c.signal;
}

/** Fetch with a hard timeout, aborted early when a newer selection supersedes it. */
async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: anySignal([signal, timeout.signal]) });
  } catch (e) {
    if (timeout.signal.aborted) throw new TimeoutError("The vehicle service took too long to respond.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
  return body as T;
}

const selectClass =
  "h-11 w-full min-w-0 rounded-md border border-line bg-bg px-3 text-[15px] text-ink transition-colors hover:border-line-strong disabled:opacity-40 sm:h-10 sm:text-sm";

const STAGE_LABEL: Record<Level, string> = {
  makes: "Loading manufacturers",
  models: "Finding models",
  trims: "Checking trims & specifications",
  spec: "Loading verified specifications",
  vin: "Decoding VIN with NHTSA",
};

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-muted">
      {children}
    </label>
  );
}

export default function VehicleSelector() {
  const { state, dispatch } = useApp();
  const [source, setSource] = useState<Source>("lookup");
  const [year, setYear] = useState<number | "">("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trimId, setTrimId] = useState("");
  const [makes, setMakes] = useState<Loadable<string[]>>(idle([]));
  const [models, setModels] = useState<Loadable<string[]>>(idle([]));
  const [trims, setTrims] = useState<Loadable<TrimOption[]>>(idle([]));
  const [spec, setSpec] = useState<Loadable<null>>(idle(null));
  const [pending, setPending] = useState<SpecSet | null>(null);
  const [vin, setVin] = useState("");
  const [vinState, setVinState] = useState<Loadable<SpecSet | null>>(idle(null));
  const [customName, setCustomName] = useState("");
  const [customYear, setCustomYear] = useState("");

  const edited = !!state.config.stock && JSON.stringify(state.config.stock.values) !== JSON.stringify(state.baseline?.values ?? null);
  const hasWork = !!state.config.modified || edited;
  const current = state.config.stock;

  // One controller per dependent level: a newer selection aborts older requests, so a slow
  // response can never overwrite a newer choice.
  const ctrl = useRef<Partial<Record<Level, AbortController>>>({});
  const begin = (level: Level) => {
    ctrl.current[level]?.abort();
    const c = new AbortController();
    ctrl.current[level] = c;
    return c.signal;
  };
  const cancel = (...levels: Level[]) => levels.forEach((l) => ctrl.current[l]?.abort());
  useEffect(() => () => Object.values(ctrl.current).forEach((c) => c?.abort()), []);

  const run = useCallback(async <T,>(level: Level, url: string, set: (l: Loadable<T>) => void, empty: T, onData?: (d: T) => void) => {
    const signal = begin(level);
    set({ status: "loading", data: empty });
    try {
      const d = await getJson<T>(url, signal);
      if (signal.aborted) return;
      set({ status: "ready", data: d });
      onData?.(d);
    } catch (e) {
      if (signal.aborted) return;
      set({ status: "error", data: empty, error: (e as Error).message });
    }
  }, []);

  const loadMakes = (y: number) =>
    run<{ makes: string[] }>("makes", `/api/vehicles/makes?year=${y}`, (l) => setMakes({ ...l, data: l.data.makes ?? [] }), { makes: [] });
  const loadModels = (y: number, mk: string) =>
    run<{ models: string[] }>("models", `/api/vehicles/models?year=${y}&make=${encodeURIComponent(mk)}`, (l) => setModels({ ...l, data: l.data.models ?? [] }), { models: [] });
  const loadTrims = (y: number, mk: string, md: string) =>
    run<{ trims: TrimOption[] }>(
      "trims",
      `/api/vehicles/trims?year=${y}&make=${encodeURIComponent(mk)}&model=${encodeURIComponent(md)}`,
      (l) => setTrims({ ...l, data: l.data.trims ?? [] }),
      { trims: [] },
    );

  const offer = (specSet: SpecSet) => {
    if (hasWork) setPending(specSet);
    else dispatch({ type: "loadVehicle", specSet });
  };

  const loadSpec = (id: string) =>
    run<{ specSet: SpecSet | null }>("spec", `/api/vehicles/spec?trimId=${encodeURIComponent(id)}`, (l) => setSpec({ ...l, data: null }), { specSet: null }, (d) => d.specSet && offer(d.specSet));

  const onYear = (v: string) => {
    const y = v ? Number(v) : "";
    setYear(y);
    setMake("");
    setModel("");
    setTrimId("");
    cancel("models", "trims", "spec");
    setModels(idle([]));
    setTrims(idle([]));
    setSpec(idle(null));
    if (y) loadMakes(y);
    else setMakes(idle([]));
  };

  const onMake = (v: string) => {
    setMake(v);
    setModel("");
    setTrimId("");
    cancel("trims", "spec");
    setTrims(idle([]));
    setSpec(idle(null));
    if (v) preloadBrandMarks();
    if (v && year) loadModels(year, v);
    else setModels(idle([]));
  };

  const onModel = (v: string) => {
    setModel(v);
    setTrimId("");
    cancel("spec");
    setSpec(idle(null));
    if (v && year && hasDatasetSpecs(year)) loadTrims(year, make, v);
    else setTrims(idle([]));
  };

  const onTrim = (v: string) => {
    setTrimId(v);
    if (v) loadSpec(v);
  };

  const decodeVin = () =>
    run<{ specSet: SpecSet | null }>("vin", `/api/vehicles/vin?vin=${encodeURIComponent(vin.trim())}`, (l) => setVinState({ ...l, data: l.data.specSet }), { specSet: null });

  /** Skip further searching: turn whatever is selected so far into a manual-entry vehicle. */
  const enterManually = () => {
    const name = [make, model].filter(Boolean).join(" ");
    setCustomName(name);
    setCustomYear(year ? String(year) : "");
    setSource("custom");
  };

  const datasetYear = year !== "" && hasDatasetSpecs(year);
  const levels: [Level, Loadable<unknown>][] = [
    ["makes", makes],
    ["models", models],
    ["trims", trims],
    ["spec", spec],
  ];
  const active = levels.find(([, l]) => l.status === "loading");
  const failed = levels.find(([, l]) => l.status === "error");
  const retry = (level: Level) => {
    if (!year) return;
    if (level === "makes") loadMakes(year);
    if (level === "models") loadModels(year, make);
    if (level === "trims") loadTrims(year, make, model);
    if (level === "spec") loadSpec(trimId);
  };

  return (
    <div className="space-y-4">
      <Segmented
        label="Vehicle source"
        value={source}
        onChange={setSource}
        options={[
          { value: "lookup", label: "Lookup" },
          { value: "vin", label: "VIN" },
          { value: "custom", label: "Enter manually" },
        ]}
      />

      {source === "lookup" && (
        <div className="animate-fade space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="min-w-0">
              <FieldLabel htmlFor="sel-year">Year</FieldLabel>
              <select id="sel-year" className={selectClass} value={year} onChange={(e) => onYear(e.target.value)}>
                <option value="">Select year</option>
                <optgroup label="Verified specifications (2015–2020)">
                  {DATASET_YEARS.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Identification only (NHTSA)">
                  {selectableYears()
                    .filter((y) => !hasDatasetSpecs(y))
                    .map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                </optgroup>
              </select>
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor="sel-make">Make</FieldLabel>
              <select id="sel-make" className={selectClass} value={make} disabled={makes.status !== "ready"} onChange={(e) => onMake(e.target.value)}>
                <option value="">{year ? (makes.status === "loading" ? "Loading…" : "Select make") : "Choose a year first"}</option>
                {makes.data.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor="sel-model">Model</FieldLabel>
              <select id="sel-model" className={selectClass} value={model} disabled={models.status !== "ready" || !models.data.length} onChange={(e) => onModel(e.target.value)}>
                <option value="">
                  {models.status === "loading" ? "Loading…" : models.status === "ready" && !models.data.length ? "No models found" : make ? "Select model" : "Choose a make first"}
                </option>
                {models.data.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor="sel-trim">Trim / powertrain</FieldLabel>
              <select id="sel-trim" className={selectClass} value={trimId} disabled={!datasetYear || trims.status !== "ready" || !trims.data.length} onChange={(e) => onTrim(e.target.value)}>
                <option value="">
                  {year !== "" && !datasetYear
                    ? "No trim data for this year"
                    : trims.status === "loading"
                      ? "Loading…"
                      : trims.status === "ready" && !trims.data.length
                        ? "No trims found"
                        : model
                          ? "Select trim"
                          : "Choose a model first"}
                </option>
                {trims.data.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {t.detail}
                    {t.complete ? "" : " (some specs missing)"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {active && !failed && <LoadingStage make={make || null} label={active[0] === "models" && make ? `Finding ${make} models` : STAGE_LABEL[active[0]]} compact />}
          {failed && (
            <LoadingStage
              make={make || null}
              state="error"
              label={failed[1].error?.includes("too long") ? "The vehicle service is taking too long" : "Couldn't load vehicle data"}
              detail={`${failed[1].error ?? ""} You can retry or enter the vehicle manually.`}
              onRetry={() => retry(failed[0])}
              compact
            />
          )}

          {year !== "" && !datasetYear && (
            <p className="text-xs leading-5 text-muted">
              For {year}, NHTSA confirms which models exist, but provides no verified power, torque or weight. After choosing a model you&apos;ll enter power and curb weight
              yourself (labeled user-provided).
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {year !== "" && !datasetYear && model && (
              <Button
                variant="primary"
                onClick={() =>
                  offer(
                    identityOnlySpecSet({
                      year: year as number,
                      make,
                      model,
                      trim: null,
                      source: "nhtsa",
                      sourceDetail: "NHTSA vPIC (identification only)",
                      notes: ["Identified by NHTSA — no performance specifications available. Enter power and curb weight to simulate."],
                    }),
                  )
                }
              >
                Use {year} {make} {model}
              </Button>
            )}
            <button type="button" onClick={enterManually} className="text-xs text-muted underline decoration-dotted underline-offset-4 hover:text-ink">
              Can&apos;t find it? Enter the vehicle manually
            </button>
          </div>
        </div>
      )}

      {source === "vin" && (
        <div className="animate-fade space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="vin" className="sr-only">
              VIN
            </label>
            <input
              id="vin"
              value={vin}
              maxLength={17}
              autoComplete="off"
              spellCheck={false}
              placeholder="17-character VIN"
              onChange={(e) => setVin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && vin.length === 17 && decodeVin()}
              className="num h-11 w-full rounded-md border border-line bg-bg px-3 text-[15px] tracking-wider sm:h-10 sm:max-w-xs sm:text-sm"
            />
            <Button onClick={decodeVin} disabled={vin.length !== 17 || vinState.status === "loading"}>
              Decode with NHTSA
            </Button>
          </div>
          {vinState.status === "loading" && <LoadingStage label={STAGE_LABEL.vin} compact />}
          {vinState.status === "error" && <LoadingStage state="error" label="Couldn't decode that VIN" detail={vinState.error} onRetry={decodeVin} compact />}
          {vinState.status === "ready" && vinState.data && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-raised px-3 py-2.5">
              <div className="min-w-0 text-sm">
                <div className="font-medium">{vehicleLabel(vinState.data.identity)}</div>
                <div className="text-xs text-muted">
                  {[vinState.data.identity.engineDescription, vinState.data.identity.bodyStyle].filter(Boolean).join(" · ") || "Identified by NHTSA"} — weight and torque are not in VIN data.
                </div>
              </div>
              <Button variant="primary" size="sm" onClick={() => offer(vinState.data!)}>
                Use this vehicle
              </Button>
            </div>
          )}
        </div>
      )}

      {source === "custom" && (
        <form
          className="animate-fade grid gap-3 sm:grid-cols-[1fr_120px_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            const y = Number(customYear);
            if (customName.trim()) offer(customSpecSet(customName.slice(0, 120), Number.isInteger(y) && y > 1885 && y < 2100 ? y : null));
          }}
        >
          <div className="min-w-0">
            <FieldLabel htmlFor="custom-name">Vehicle name</FieldLabel>
            <input
              id="custom-name"
              value={customName}
              maxLength={120}
              placeholder="e.g. Honda Civic, project car"
              onChange={(e) => setCustomName(e.target.value)}
              className="h-11 w-full rounded-md border border-line bg-bg px-3 text-[15px] sm:h-10 sm:text-sm"
            />
          </div>
          <div>
            <FieldLabel htmlFor="custom-year">Year (optional)</FieldLabel>
            <input
              id="custom-year"
              inputMode="numeric"
              value={customYear}
              maxLength={4}
              onChange={(e) => setCustomYear(e.target.value.replace(/\D/g, ""))}
              className="num h-11 w-full rounded-md border border-line bg-bg px-3 text-[15px] sm:h-10 sm:text-sm"
            />
          </div>
          <Button type="submit" variant="primary" disabled={!customName.trim()}>
            Continue
          </Button>
          <p className="text-xs leading-5 text-muted sm:col-span-3">You&apos;ll only need power and curb weight. AutoDyn fills the rest with labeled defaults you can change.</p>
        </form>
      )}

      {pending && (
        <Notice
          tone="warning"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => (dispatch({ type: "loadVehicle", specSet: pending }), setPending(null))}>
                Replace
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                Keep current
              </Button>
            </div>
          }
        >
          Load <strong className="text-ink">{vehicleLabel(pending.identity)}</strong>? This replaces {current ? vehicleLabel(current.identity) : "the current vehicle"}
          {state.config.modified ? " and clears its modified scenario." : " and discards your edits to it."}
        </Notice>
      )}

      {current && (
        <div key={current.identity.datasetTrimId ?? vehicleLabel(current.identity)} className="animate-enter flex items-start gap-3 rounded-md border border-line bg-bg/60 px-3 py-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-line bg-raised">
            <BrandGlyph make={current.identity.make} size={24} />
          </div>
          <div className="min-w-0 flex-1 text-[13px] leading-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{vehicleLabel(current.identity)}</span>
              <ProvenanceTag provenance={current.identity.source === "dataset" ? "verified" : current.identity.source === "custom" ? "user" : "unavailable"} title={current.identity.sourceDetail} />
            </div>
            <div className={cx("text-xs", current.identity.source === "dataset" ? "text-muted" : "text-caution")}>
              {current.identity.source === "dataset"
                ? current.identity.sourceDetail
                : current.identity.source === "custom"
                  ? "Custom vehicle — all values are yours"
                  : "Identified only — no verified performance specifications"}
            </div>
            {current.identity.notes.map((n) => (
              <p key={n} className="mt-1 text-xs text-caution">
                {n}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
