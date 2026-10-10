// The one authoritative, live simulation status. Chat messages are historical records of what was
// true when they were written; live indicators (Current configuration, Review changes) use this.

export type SimPhase = "no_vehicle" | "proposal_pending" | "configured" | "running" | "complete" | "outdated";

export type SimStatus = { phase: SimPhase; label: string; detail: string; tone: "muted" | "warning" | "success" };

export function simulationStatus(s: { hasVehicle: boolean; pendingProposal: boolean; running: boolean; hasResult: boolean; stale: boolean }): SimStatus {
  if (s.running) return { phase: "running", label: "Analysis running", detail: "AutoDyn's physics engine is calculating the results.", tone: "muted" };
  if (s.pendingProposal) {
    return {
      phase: "proposal_pending",
      label: "Proposal pending",
      detail: `No simulation has run for it yet.${s.hasResult && !s.stale ? " The current results cover the applied configuration only." : ""}`,
      tone: "warning",
    };
  }
  if (!s.hasVehicle) return { phase: "no_vehicle", label: "No vehicle", detail: "Choose a vehicle to begin.", tone: "muted" };
  if (!s.hasResult) return { phase: "configured", label: "Configuration applied", detail: "Not simulated yet — select Run analysis.", tone: "muted" };
  if (s.stale) return { phase: "outdated", label: "Results outdated", detail: "Configuration changed. Rerun the analysis to update results.", tone: "warning" };
  return { phase: "complete", label: "Analysis complete", detail: "Simulation complete. Results are current.", tone: "success" };
}
