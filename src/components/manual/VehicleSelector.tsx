"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, cx, Notice, Segmented, Spinner } from "@/components/ui";
import type { SpecSet } from "@/lib/domain/types";
import { DATASET_YEARS, hasDatasetSpecs, selectableYears } from "@/lib/vehicles/catalog";
import { customSpecSet, identityOnlySpecSet, vehicleLabel } from "@/lib/vehicles/normalize";
import { useApp } from "@/state/AppProvider";

type Source = "lookup" | "vin" | "custom";
type TrimOption = { id: string; label: string; detail: string; complete: boolean };
type Loadable<T> = { status: "idle" | "loading" | "ready" | "error"; data: T; error?: string; source?: string };

const idle = <T,>(data: T): Loadable<T> => ({ status: "idle", data });

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status}).`);
  return body as T;
}

const selectClass =
  "h-10 w-full min-w-0 rounded-md border border-line bg-bg px-3 text-sm text-ink transition-colors hover:border-line-strong disabled:opacity-40";

function FieldLabel({ htmlFor, children, status }: { htmlFor: string; children: React.ReactNode; status?: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-center justify-between gap-2 text-xs font-medium text-muted">
      <span>{children}</span>
      {status}
    </label>
  );
}

/** Replacing a vehicle discards edits; ask first when there is meaningful work to lose. */
function useReplaceGuard() {
  const { state } = useApp();
  const edited = !!state.config.stock && JSON.stringify(state.config.stock.values) !== JSON.stringify(state.baseline?.values ?? null);
  const hasWork = !!state.config.modified || edited;
  return { hasWork, current: state.config.stock ? vehicleLabel(state.config.stock.identity) : null };
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
  const guard = useReplaceGuard();

  // One controller per dependent level: a newer selection aborts older requests, so a slow
  // response can never overwrite a newer choice.
  const ctrl = useRef<Record<string, AbortController | undefined>>({});
  const begin = (level: string) => {
    ctrl.current[level]?.abort();
    const c = new AbortController();
    ctrl.current[level] = c;
    return c.signal;
  };
  useEffect(() => () => Object.values(ctrl.current).forEach((c) => c?.abort()), []);

  const loadMakes = useCallback(async (y: number) => {
    const signal = begin("makes");
    setMakes({ status: "loading", data: [] });
    try {
      const d = await getJson<{ makes: string[]; source: string }>(`/api/vehicles/makes?year=${y}`, signal);
      setMakes({ status: "ready", data: d.makes, source: d.source });
    } catch (e) {
      if (!signal.aborted) setMakes({ status: "error", data: [], error: (e as Error).message });
    }
  }, []);

  const loadModels = useCallback(async (y: number, mk: string) => {
    const signal = begin("models");
    setModels({ status: "loading", data: [] });
    try {
      const d = await getJson<{ models: string[]; source: string }>(`/api/vehicles/models?year=${y}&make=${encodeURIComponent(mk)}`, signal);
      setModels({ status: "ready", data: d.models, source: d.source });
    } catch (e) {
      if (!signal.aborted) setModels({ status: "error", data: [], error: (e as Error).message });
    }
  }, []);

  const loadTrims = useCallback(async (y: number, mk: string, md: string) => {
    const signal = begin("trims");
    setTrims({ status: "loading", data: [] });
    try {
      const d = await getJson<{ trims: TrimOption[] }>(`/api/vehicles/trims?year=${y}&make=${encodeURIComponent(mk)}&model=${encodeURIComponent(md)}`, signal);
      setTrims({ status: "ready", data: d.trims });
    } catch (e) {
      if (!signal.aborted) setTrims({ status: "error", data: [], error: (e as Error).message });
    }
  }, []);

  const offer = (specSet: SpecSet) => {
    if (guard.hasWork) setPending(specSet);
    else dispatch({ type: "loadVehicle", specSet });
  };

  const loadSpec = useCallback(
    async (id: string) => {
      const signal = begin("spec");
      setSpec({ status: "loading", data: null });
      try {
        const d = await getJson<{ specSet: SpecSet }>(`/api/vehicles/spec?trimId=${encodeURIComponent(id)}`, signal);
        setSpec({ status: "ready", data: null });
        offer(d.specSet);
      } catch (e) {
        if (!signal.aborted) setSpec({ status: "error", data: null, error: (e as Error).message });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guard.hasWork],
  );

  const onYear = (v: string) => {
    const y = v ? Number(v) : "";
    setYear(y);
    setMake("");
    setModel("");
    setTrimId("");
    ["models", "trims", "spec"].forEach((l) => ctrl.current[l]?.abort());
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
    ["trims", "spec"].forEach((l) => ctrl.current[l]?.abort());
    setTrims(idle([]));
    setSpec(idle(null));
    if (v && year) loadModels(year, v);
    else setModels(idle([]));
  };

  const onModel = (v: string) => {
    setModel(v);
    setTrimId("");
    ctrl.current.spec?.abort();
    setSpec(idle(null));
    if (v && year && hasDatasetSpecs(year)) loadTrims(year, make, v);
    else setTrims(idle([]));
  };

  const onTrim = (v: string) => {
    setTrimId(v);
    if (v) loadSpec(v);
  };

  const decodeVin = async () => {
    const signal = begin("vin");
    setVinState({ status: "loading", data: null });
    try {
      const d = await getJson<{ specSet: SpecSet }>(`/api/vehicles/vin?vin=${encodeURIComponent(vin.trim())}`, signal);
      setVinState({ status: "ready", data: d.specSet });
    } catch (e) {
      if (!signal.aborted) setVinState({ status: "error", data: null, error: (e as Error).message });
    }
  };

  const datasetYear = year !== "" && hasDatasetSpecs(year);
  const status = (l: Loadable<unknown>) => (l.status === "loading" ? <Spinner label="Loading options" /> : null);

  return (
    <div className="space-y-4">
      <Segmented
        label="Vehicle source"
        value={source}
        onChange={setSource}
        options={[
          { value: "lookup", label: "Year / make / model" },
          { value: "vin", label: "VIN decode" },
          { value: "custom", label: "Custom vehicle" },
        ]}
      />

      {source === "lookup" && (
        <div className="animate-fade space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="min-w-0">
              <FieldLabel htmlFor="sel-year">Year</FieldLabel>
              <select id="sel-year" className={selectClass} value={year} onChange={(e) => onYear(e.target.value)}>
                <option value="">Select year</option>
                <optgroup label="Full specifications">
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
              <FieldLabel htmlFor="sel-make" status={status(makes)}>
                Make
              </FieldLabel>
              <select id="sel-make" className={selectClass} value={make} disabled={makes.status !== "ready"} onChange={(e) => onMake(e.target.value)}>
                <option value="">{year ? "Select make" : "Choose a year first"}</option>
                {makes.data.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor="sel-model" status={status(models)}>
                Model
              </FieldLabel>
              <select id="sel-model" className={selectClass} value={model} disabled={models.status !== "ready" || !models.data.length} onChange={(e) => onModel(e.target.value)}>
                <option value="">{models.status === "ready" && !models.data.length ? "No models found" : make ? "Select model" : "Choose a make first"}</option>
                {models.data.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor="sel-trim" status={status(trims) ?? status(spec)}>
                Trim / powertrain
              </FieldLabel>
              <select
                id="sel-trim"
                className={selectClass}
                value={trimId}
                disabled={!datasetYear || trims.status !== "ready" || !trims.data.length}
                onChange={(e) => onTrim(e.target.value)}
              >
                <option value="">
                  {year !== "" && !datasetYear ? "Not available for this year" : trims.status === "ready" && !trims.data.length ? "No trims found" : model ? "Select trim" : "Choose a model first"}
                </option>
                {trims.data.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · {t.detail}
                    {t.complete ? "" : " (incomplete data)"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {year !== "" && !datasetYear && (
            <p className="text-xs leading-5 text-muted">
              AutoDyn&apos;s specification dataset covers {DATASET_YEARS.at(-1)}–{DATASET_YEARS[0]}. For {year}, NHTSA identifies the model; you then enter
              power and curb mass yourself (labeled user-provided).
            </p>
          )}

          {[makes, models, trims, spec].map(
            (l, i) =>
              l.status === "error" && (
                <Notice
                  key={i}
                  tone="error"
                  action={
                    <Button
                      size="sm"
                      onClick={() =>
                        i === 0 ? year && loadMakes(year) : i === 1 ? year && loadModels(year, make) : i === 2 ? year && loadTrims(year, make, model) : loadSpec(trimId)
                      }
                    >
                      <RotateCcw size={14} aria-hidden /> Retry
                    </Button>
                  }
                >
                  {l.error} {i === 1 && "You can also switch to Custom vehicle and enter specifications directly."}
                </Notice>
              ),
          )}

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
                    notes: ["NHTSA identifies this model but does not provide performance specifications. Enter peak power and curb mass to simulate."],
                  }),
                )
              }
            >
              Use {year} {make} {model}
            </Button>
          )}
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
              className="num h-10 w-full rounded-md border border-line bg-bg px-3 text-sm tracking-wider sm:max-w-xs"
            />
            <Button onClick={decodeVin} disabled={vin.length !== 17 || vinState.status === "loading"}>
              {vinState.status === "loading" ? <Spinner /> : "Decode with NHTSA"}
            </Button>
          </div>
          {vinState.status === "error" && (
            <Notice tone="error" action={<Button size="sm" onClick={decodeVin}>Retry</Button>}>
              {vinState.error}
            </Notice>
          )}
          {vinState.status === "ready" && vinState.data && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-raised px-3 py-2.5">
              <div className="min-w-0 text-sm">
                <div className="font-medium">{vehicleLabel(vinState.data.identity)}</div>
                <div className="text-xs text-muted">{[vinState.data.identity.engineDescription, vinState.data.identity.bodyStyle].filter(Boolean).join(" · ") || "Decoded by NHTSA vPIC"}</div>
              </div>
              <Button variant="primary" size="sm" onClick={() => offer(vinState.data!)}>
                Use this vehicle
              </Button>
            </div>
          )}
          <p className="text-xs leading-5 text-muted">VIN decoding identifies the vehicle and any powertrain details NHTSA has on file. Mass and torque are not in VIN data.</p>
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
              placeholder="e.g. Project car, Mazda MX-5 swap"
              onChange={(e) => setCustomName(e.target.value)}
              className="h-10 w-full rounded-md border border-line bg-bg px-3 text-sm"
            />
          </div>
          <div>
            <FieldLabel htmlFor="custom-year">Year (optional)</FieldLabel>
            <input id="custom-year" inputMode="numeric" value={customYear} maxLength={4} onChange={(e) => setCustomYear(e.target.value.replace(/\D/g, ""))} className="num h-10 w-full rounded-md border border-line bg-bg px-3 text-sm" />
          </div>
          <Button type="submit" variant="primary" disabled={!customName.trim()}>
            Create custom vehicle
          </Button>
          <p className="text-xs leading-5 text-muted sm:col-span-3">
            Every value you enter is labeled user-provided. Peak power and curb mass are required; AutoDyn estimates the rest and labels each estimate.
          </p>
        </form>
      )}

      {pending && (
        <Notice
          tone="warning"
          action={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  dispatch({ type: "loadVehicle", specSet: pending });
                  setPending(null);
                }}
              >
                Replace
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                Keep current
              </Button>
            </div>
          }
        >
          Load <strong className="text-ink">{vehicleLabel(pending.identity)}</strong>? This replaces {guard.current ?? "the current vehicle"}
          {state.config.modified ? " and clears its modified scenario." : " and discards your edits."}
        </Notice>
      )}

      {state.config.stock && (
        <div className={cx("rounded-md border border-line bg-bg/60 px-3 py-2.5 text-[13px] leading-5")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-ink">{vehicleLabel(state.config.stock.identity)}</span>
            <span className="text-xs text-faint">{state.config.stock.identity.sourceDetail}</span>
          </div>
          {state.config.stock.identity.engineDescription && <div className="text-xs text-muted">{state.config.stock.identity.engineDescription}</div>}
          {state.config.stock.identity.notes.map((n) => (
            <p key={n} className="mt-1 text-xs text-caution">
              {n}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
