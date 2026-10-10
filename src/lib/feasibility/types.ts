import type { Provenance, ScenarioId } from "@/lib/domain/types";
import type { Issue } from "@/lib/domain/validation";

/** Engineering feasibility — deliberately separate from input validation (see InputErrorResult). */
export type FeasibilityStatus = "feasible" | "questionable" | "non_feasible" | "insufficient_data";

export const FEASIBILITY_HEADLINE: Record<FeasibilityStatus, string> = {
  feasible: "Feasible within modeled constraints",
  questionable: "Requires further verification",
  non_feasible: "Conflicts with modeled constraints",
  insufficient_data: "Insufficient data to assess",
};

export const FEASIBILITY_LABEL: Record<FeasibilityStatus, string> = {
  feasible: "Feasible",
  questionable: "Questionable",
  non_feasible: "Non-feasible",
  insufficient_data: "Insufficient data",
};

export type CheckOutcome = "pass" | "caution" | "violation" | "not_assessed";

export type CheckCategory = "claims" | "mechanical" | "traction" | "data" | "powertrain" | "mass" | "aero" | "acceleration" | "model";

export type ConstraintCheck = {
  id: string;
  category: CheckCategory;
  label: string;
  outcome: CheckOutcome;
  detail: string;
  /** Quantities the check used, with explicit units. */
  values?: { label: string; value: string }[];
  suggestion?: string;
};

export type FeasibilityAssessment = {
  scenario: ScenarioId;
  status: FeasibilityStatus;
  headline: string;
  primaryReason: string;
  checks: ConstraintCheck[];
  inputs: { label: string; value: string; provenance: Provenance }[];
  assumptions: string[];
  missing: string[];
  suggestions: string[];
  engineVersion: string;
};

/** Invalid inputs are reported as input errors, never as a feasibility status. */
export type InputErrorResult = { scenario: ScenarioId; status: "input_error"; issues: Issue[] };

export type ScenarioAssessment = FeasibilityAssessment | InputErrorResult;

export const FEASIBILITY_ENGINE_VERSION = "autodyn-feasibility/1.0.0";
