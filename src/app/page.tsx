"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Car, CheckCircle2, Loader2, Search } from "lucide-react";
import VehicleChart from "@/components/VehicleChart";
import type {
  BuildHealth,
  SimulationResult,
  VehicleSpecs,
} from "@/lib/vehicleTypes";

type SimResponse = {
  vehicle: VehicleSpecs;
  simulation: SimulationResult;
  buildHealth: BuildHealth;
};

type TrimOption = {
  id: string;
  label: string;
};

const YEARS = Array.from(
  { length: new Date().getFullYear() - 1980 },
  (_, index) => new Date().getFullYear() - index
);

export default function Home() {
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [trims, setTrims] = useState<TrimOption[]>([]);

  const [make, setMake] = useState("");
  const [year, setYear] = useState<number | "">("");
  const [model, setModel] = useState("");
  const [trimId, setTrimId] = useState("");
  const [trim, setTrim] = useState("");

  const [vehicleFound, setVehicleFound] = useState(false);

  const [horsepower, setHorsepower] = useState<number | "">("");
  const [modifiedHorsepower, setModifiedHorsepower] = useState<number | "">("");
  const [torqueLbFt, setTorqueLbFt] = useState<number | "">("");
  const [engine, setEngine] = useState("");
  const [weightKg, setWeightKg] = useState<number | "">("");
  const [dragCoefficient, setDragCoefficient] = useState<number | "">("");
  const [frontalAreaM2, setFrontalAreaM2] = useState<number | "">("");
  const [drivetrainLoss, setDrivetrainLoss] = useState<number | "">("");
  const [tireGrip, setTireGrip] = useState<number | "">("");
  const [drivetrain, setDrivetrain] = useState("");
  const [transmission, setTransmission] = useState("");
  const [bodyStyle, setBodyStyle] = useState("");

  const [loadingMakes, setLoadingMakes] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadingTrims, setLoadingTrims] = useState(false);
  const [loadingSpecs, setLoadingSpecs] = useState(false);
  const [loadingSim, setLoadingSim] = useState(false);

  const [error, setError] = useState("");
  const [result, setResult] = useState<SimResponse | null>(null);

  useEffect(() => {
    async function loadMakes() {
      setLoadingMakes(true);

      try {
        const response = await fetch("/api/makes");
        const data = await response.json();
        setMakes(data.makes ?? []);
      } catch {
        setError("Could not load vehicle manufacturers.");
      } finally {
        setLoadingMakes(false);
      }
    }

    loadMakes();
  }, []);

  function resetSimulation() {
    setModels([]);
    setTrims([]);
    setMake("");
    setYear("");
    setModel("");
    setTrimId("");
    setTrim("");
    setVehicleFound(false);

    setHorsepower("");
    setModifiedHorsepower("");
    setTorqueLbFt("");
    setEngine("");
    setWeightKg("");
    setDragCoefficient("");
    setFrontalAreaM2("");
    setDrivetrainLoss("");
    setTireGrip("");
    setDrivetrain("");
    setTransmission("");
    setBodyStyle("");

    setLoadingModels(false);
    setLoadingTrims(false);
    setLoadingSpecs(false);
    setLoadingSim(false);

    setError("");
    setResult(null);
  }

  async function loadModels() {
    setError("");
    setModels([]);
    setTrims([]);
    setModel("");
    setTrim("");
    setTrimId("");
    setVehicleFound(false);
    setResult(null);

    if (!make || !year) {
      setError("Select a manufacturer and model year first.");
      return;
    }

    setLoadingModels(true);

    try {
      const response = await fetch(
        `/api/models?make=${encodeURIComponent(make)}&year=${year}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not load available models.");
      }

      setModels(data.models ?? []);

      if (!data.models || data.models.length === 0) {
        setError("No models were found for that manufacturer/year combination.");
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load models from the vehicle dataset."
      );
    } finally {
      setLoadingModels(false);
    }
  }

  async function loadTrims(selectedModel: string) {
    setError("");
    setTrims([]);
    setTrim("");
    setTrimId("");
    setVehicleFound(false);
    setResult(null);

    if (!make || !year || !selectedModel) return;

    setLoadingTrims(true);

    try {
      const response = await fetch(
        `/api/trims?make=${encodeURIComponent(make)}&model=${encodeURIComponent(
          selectedModel
        )}&year=${year}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not load trim-level vehicles.");
      }

      setTrims(data.trims ?? []);

      if (!data.trims || data.trims.length === 0) {
        setError(
          "No trim-level records were found in the dataset for that model/year."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load trim-level vehicle records."
      );
    } finally {
      setLoadingTrims(false);
    }
  }

  async function loadSpecs(selectedTrimId: string, selectedTrimLabel: string) {
    setError("");
    setVehicleFound(false);
    setResult(null);

    setTrimId(selectedTrimId);
    setTrim(selectedTrimLabel);

    if (!selectedTrimId) return;

    setLoadingSpecs(true);

    try {
      const response = await fetch(
        `/api/vehicle-specs?trimId=${encodeURIComponent(selectedTrimId)}`
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Vehicle specifications could not be loaded."
        );
      }

      const specs = data.specs;

      setEngine(specs.engine || "");
      setHorsepower(specs.horsepower || "");
      setModifiedHorsepower(specs.modifiedHorsepower || "");
      setTorqueLbFt(specs.torqueLbFt || "");
      setWeightKg(specs.weightKg || "");
      setDragCoefficient(specs.dragCoefficient || "");
      setFrontalAreaM2(specs.frontalAreaM2 || "");
      setDrivetrainLoss(specs.drivetrainLoss || "");
      setTireGrip(specs.tireGrip || "");
      setDrivetrain(specs.drivetrain || "");
      setTransmission(specs.transmission || "");
      setBodyStyle(specs.bodyStyle || "");

      setVehicleFound(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Trim found, but specifications could not be loaded."
      );
    } finally {
      setLoadingSpecs(false);
    }
  }

  function validateInputs() {
    if (!make || !year || !model || !trim) {
      return "Select manufacturer, year, model, and trim before running analysis.";
    }

    if (!horsepower) return "Stock horsepower is missing.";
    if (!modifiedHorsepower) return "Modified horsepower is missing.";
    if (!weightKg) return "Vehicle weight is missing.";
    if (!dragCoefficient) return "Drag coefficient is missing.";
    if (!frontalAreaM2) return "Frontal area is missing.";
    if (!drivetrainLoss && drivetrainLoss !== 0) {
      return "Drivetrain loss is missing.";
    }
    if (!tireGrip) return "Tire grip coefficient is missing.";

    return "";
  }

  async function runSimulation() {
    const validationError = validateInputs();

    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setLoadingSim(true);

    try {
      const response = await fetch("/api/simulate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          make,
          model,
          trim,
          year,
          horsepower,
          modifiedHorsepower,
          weightKg,
          dragCoefficient,
          frontalAreaM2,
          drivetrainLoss,
          tireGrip,
          engine,
          torqueLbFt,
          drivetrain,
          transmission,
          bodyStyle,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Performance analysis failed.");
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Performance analysis failed.");
    } finally {
      setLoadingSim(false);
    }
  }

  return (
    <main className="min-h-screen px-6 py-12 text-white">
      <section className="mx-auto max-w-7xl">
        <div className="border-b border-violet-500/20 pb-10">
          <p className="text-sm font-black uppercase tracking-[0.35em] text-violet-400">
            AutoDyn Performance Lab
          </p>

          <h1 className="mt-4 max-w-5xl text-5xl font-black leading-tight md:text-6xl">
            Engineering-grade vehicle performance analysis.
          </h1>

          <p className="mt-5 max-w-3xl leading-8 text-neutral-400">
            Select a vehicle from a structured automotive dataset, load key
            technical specifications, and compare stock versus modified
            performance using a physics-based simulation model.
          </p>
        </div>

        <section className="mt-10 grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="rounded-3xl border border-violet-500/20 bg-white/[0.03] p-6">
            <h2 className="flex items-center gap-2 text-2xl font-black">
              <Search className="text-violet-300" />
              Vehicle Configuration
            </h2>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <SelectBox
                label="Manufacturer"
                value={make}
                onChange={(value) => {
                  setMake(value);
                  setModels([]);
                  setTrims([]);
                  setModel("");
                  setTrim("");
                  setVehicleFound(false);
                  setResult(null);
                }}
                options={makes}
                placeholder={
                  loadingMakes ? "Loading manufacturers..." : "Select manufacturer"
                }
              />

              <SelectBox
                label="Model Year"
                value={year}
                onChange={(value) => {
                  setYear(Number(value));
                  setModels([]);
                  setTrims([]);
                  setModel("");
                  setTrim("");
                  setVehicleFound(false);
                  setResult(null);
                }}
                options={YEARS.map(String)}
                placeholder="Select model year"
              />
            </div>

            <button
              onClick={loadModels}
              disabled={loadingModels}
              className="mt-5 w-full rounded-2xl bg-violet-600 px-5 py-4 font-black transition hover:bg-violet-500 disabled:opacity-60"
            >
              {loadingModels ? "Loading Models..." : "Load Available Models"}
            </button>

            {models.length > 0 && (
              <div className="mt-5">
                <SelectBox
                  label="Model"
                  value={model}
                  onChange={(value) => {
                    setModel(value);
                    loadTrims(value);
                  }}
                  options={models}
                  placeholder="Select model"
                />
              </div>
            )}

            {loadingTrims && (
              <p className="mt-4 text-sm text-violet-300">
                Loading trim-level vehicle records...
              </p>
            )}

            {trims.length > 0 && (
              <div className="mt-5">
                <SelectBox
                  label="Trim / Configuration"
                  value={trimId}
                  onChange={(value) => {
                    const selected = trims.find((item) => item.id === value);
                    loadSpecs(value, selected?.label ?? "");
                  }}
                  options={trims.map((item) => item.id)}
                  optionLabels={Object.fromEntries(
                    trims.map((item) => [item.id, item.label])
                  )}
                  placeholder="Select trim/configuration"
                />
              </div>
            )}

            {loadingSpecs && (
              <p className="mt-4 flex items-center gap-2 text-sm text-violet-300">
                <Loader2 className="animate-spin" size={16} />
                Loading technical specifications...
              </p>
            )}

            {vehicleFound && (
              <div className="mt-5 flex items-center gap-2 rounded-2xl border border-green-500/30 bg-green-500/10 p-4 text-green-300">
                <CheckCircle2 size={20} />
                Vehicle found — technical specifications loaded.
              </div>
            )}

            <h3 className="mt-8 text-xl font-black">Key Technical Inputs</h3>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <SpecInput label="Engine" value={engine} setValue={setEngine} />
              <NumberInput label="Stock HP" value={horsepower} setValue={setHorsepower} />
              <NumberInput
                label="Modified HP"
                value={modifiedHorsepower}
                setValue={setModifiedHorsepower}
              />
              <NumberInput
                label="Torque (lb-ft)"
                value={torqueLbFt}
                setValue={setTorqueLbFt}
              />
              <NumberInput label="Weight (kg)" value={weightKg} setValue={setWeightKg} />
              <SpecInput
                label="Drivetrain"
                value={drivetrain}
                setValue={setDrivetrain}
              />
            </div>

            <details className="mt-5 rounded-2xl border border-violet-500/20 bg-[#100d1c] p-4">
              <summary className="cursor-pointer font-black text-violet-200">
                Advanced Simulation Parameters
              </summary>

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <NumberInput
                  label="Drag Coefficient"
                  value={dragCoefficient}
                  setValue={setDragCoefficient}
                />
                <NumberInput
                  label="Frontal Area (m²)"
                  value={frontalAreaM2}
                  setValue={setFrontalAreaM2}
                />
                <NumberInput
                  label="Drivetrain Loss"
                  value={drivetrainLoss}
                  setValue={setDrivetrainLoss}
                />
                <NumberInput
                  label="Tire Grip μ"
                  value={tireGrip}
                  setValue={setTireGrip}
                />
                <SpecInput
                  label="Transmission"
                  value={transmission}
                  setValue={setTransmission}
                />
                <SpecInput
                  label="Body Style"
                  value={bodyStyle}
                  setValue={setBodyStyle}
                />
              </div>
            </details>

            <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_0.45fr]">
              <button
                onClick={runSimulation}
                disabled={loadingSim}
                className="w-full rounded-2xl bg-fuchsia-600 px-5 py-4 font-black transition hover:bg-fuchsia-500 disabled:opacity-60"
              >
                {loadingSim ? "Running Analysis..." : "Run Performance Analysis"}
              </button>

              <button
                onClick={resetSimulation}
                className="w-full rounded-2xl border border-violet-500/40 px-5 py-4 font-black text-violet-200 transition hover:bg-violet-500/10"
              >
                Reset
              </button>
            </div>

            {error && (
              <div className="mt-5 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                {error}
              </div>
            )}
          </div>

          <div className="space-y-6">
            {!result ? (
              <div className="flex min-h-[560px] items-center justify-center rounded-3xl border border-violet-500/20 bg-white/[0.03] p-8 text-center">
                <div>
                  <Car className="mx-auto text-violet-300" size={54} />
                  <h2 className="mt-5 text-2xl font-black">
                    Configure a vehicle to begin analysis.
                  </h2>
                  <p className="mt-3 text-neutral-400">
                    Vehicle specifications, acceleration curves, and build
                    feasibility results will appear here.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="rounded-3xl border border-violet-500/20 bg-white/[0.03] p-6">
                  <h2 className="text-2xl font-black">
                    {result.vehicle.year} {result.vehicle.make}{" "}
                    {result.vehicle.model}
                    {result.vehicle.trim ? ` ${result.vehicle.trim}` : ""}
                  </h2>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <Stat label="Engine" value={result.vehicle.engine || "Unavailable"} />
                    <Stat label="Stock HP" value={`${result.vehicle.horsepower} hp`} />
                    <Stat
                      label="Modified HP"
                      value={`${result.vehicle.modifiedHorsepower} hp`}
                    />
                    <Stat
                      label="Torque"
                      value={
                        result.vehicle.torqueLbFt
                          ? `${result.vehicle.torqueLbFt} lb-ft`
                          : "Unavailable"
                      }
                    />
                    <Stat
                      label="Stock 0–60"
                      value={
                        result.simulation.stockZeroToSixty
                          ? `${result.simulation.stockZeroToSixty}s`
                          : "N/A"
                      }
                    />

                    {result.simulation.hasModification && (
                      <>
                        <Stat
                          label="Modified 0–60"
                          value={
                            result.simulation.modifiedZeroToSixty
                              ? `${result.simulation.modifiedZeroToSixty}s`
                              : "N/A"
                          }
                        />

                        <Stat
                          label="0–60 Improvement"
                          value={
                            result.simulation.improvementPercent !== null
                              ? `${result.simulation.improvementPercent}%`
                              : "N/A"
                          }
                        />

                        <Stat
                          label="Modified Top Speed"
                          value={
                            result.simulation.modifiedTopSpeedMph !== null
                              ? `${result.simulation.modifiedTopSpeedMph} mph`
                              : "N/A"
                          }
                        />
                      </>
                    )}
                  </div>
                </div>

                <VehicleChart
                  data={result.simulation.data}
                  hasModification={result.simulation.hasModification}
                />

                <div className="rounded-3xl border border-violet-500/20 bg-white/[0.03] p-6">
                  <h2 className="text-2xl font-black">Performance Insights</h2>

                  <ul className="mt-4 space-y-3 text-sm leading-7 text-neutral-300">
                    {result.simulation.insights.map((insight) => (
                      <li key={insight}>• {insight}</li>
                    ))}
                  </ul>
                </div>

                <div
                  className={`rounded-3xl border p-6 ${
                    result.buildHealth.status === "FAIL"
                      ? "border-red-500/30 bg-red-500/10"
                      : result.buildHealth.status === "WARNING"
                        ? "border-yellow-500/30 bg-yellow-500/10"
                        : "border-green-500/30 bg-green-500/10"
                  }`}
                >
                  <h2 className="flex items-center gap-2 text-2xl font-black">
                    <AlertTriangle />
                    {result.buildHealth.title}
                  </h2>

                  <p className="mt-3 leading-7 text-neutral-300">
                    {result.buildHealth.message}
                  </p>

                  {result.buildHealth.warnings.length > 0 && (
                    <ul className="mt-4 space-y-2 text-sm text-neutral-300">
                      {result.buildHealth.warnings.map((warning) => (
                        <li key={warning}>• {warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function SelectBox({
  label,
  value,
  onChange,
  options,
  placeholder,
  optionLabels,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
  optionLabels?: Record<string, string>;
}) {
  return (
    <label>
      <span className="text-sm font-bold text-neutral-300">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-2xl border border-violet-500/20 bg-[#100d1c] p-4 outline-none focus:border-violet-400"
      >
        <option value="">{placeholder}</option>

        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  );
}

function SpecInput({
  label,
  value,
  setValue,
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
}) {
  return (
    <label>
      <span className="text-sm font-bold text-neutral-300">{label}</span>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="mt-2 w-full rounded-2xl border border-violet-500/20 bg-[#100d1c] p-4 outline-none focus:border-violet-400"
      />
    </label>
  );
}

function NumberInput({
  label,
  value,
  setValue,
}: {
  label: string;
  value: number | "";
  setValue: (value: number | "") => void;
}) {
  return (
    <label>
      <span className="text-sm font-bold text-neutral-300">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(event) =>
          setValue(event.target.value === "" ? "" : Number(event.target.value))
        }
        className="mt-2 w-full rounded-2xl border border-violet-500/20 bg-[#100d1c] p-4 outline-none focus:border-violet-400"
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-violet-500/20 bg-[#100d1c] p-4">
      <p className="text-xs uppercase tracking-widest text-neutral-500">
        {label}
      </p>
      <p className="mt-1 font-black text-violet-200">{value}</p>
    </div>
  );
}