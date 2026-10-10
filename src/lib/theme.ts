// Single source of truth for semantic colors. CSS tokens in globals.css (`--color-*`) mirror these
// values (enforced by tests/theme.test.ts). Scenario identity, validation and feasibility are
// separate palettes and must never be substituted for one another.

export const SCENARIO_COLORS = {
  stock: "#79A7FF", // blue — always Stock
  modified: "#E87942", // copper-orange — always Modified
} as const;

export const VALIDATION_COLORS = {
  error: "#EF6464", // invalid input, failed request, invalid response
  warning: "#E9B35B", // unusual but potentially valid value
  success: "#50C49A",
} as const;

export const FEASIBILITY_COLORS = {
  feasible: "#50C49A",
  questionable: "#E9B35B",
  non_feasible: "#E45B70",
  insufficient_data: "#9299A3",
} as const;

/** Non-color cues so scenarios stay distinguishable without color (charts and labels). */
export const SCENARIO_STYLE = {
  stock: { color: SCENARIO_COLORS.stock, label: "Stock", dash: undefined as string | undefined, marker: "circle" as const },
  modified: { color: SCENARIO_COLORS.modified, label: "Modified", dash: "7 4", marker: "diamond" as const },
};

export const CSS_TOKENS: Record<string, string> = {
  "--color-stock": SCENARIO_COLORS.stock,
  "--color-modified": SCENARIO_COLORS.modified,
  "--color-error": VALIDATION_COLORS.error,
  "--color-warning": VALIDATION_COLORS.warning,
  "--color-success": VALIDATION_COLORS.success,
  "--color-feasible": FEASIBILITY_COLORS.feasible,
  "--color-questionable": FEASIBILITY_COLORS.questionable,
  "--color-nonfeasible": FEASIBILITY_COLORS.non_feasible,
  "--color-insufficient": FEASIBILITY_COLORS.insufficient_data,
};
