"use client";

import { CommitInput, Row } from "@/components/manual/controls";
import { effectiveConstraints } from "@/lib/domain/scenario";
import type { ConstraintKey } from "@/lib/domain/types";
import type { Issue } from "@/lib/domain/validation";
import { fromDisplay, toDisplay, unitLabel, type Quantity } from "@/lib/units";
import { useApp } from "@/state/AppProvider";

const FIELDS: { key: ConstraintKey; label: string; quantity: Quantity; digits: number; help: string }[] = [
  { key: "claimedZeroTo60S", label: "Claimed 0–60 mph", quantity: "time", digits: 2, help: "A performance claim to check against traction and the simulation." },
  { key: "claimedTopSpeedMs", label: "Claimed top speed", quantity: "speed", digits: 0, help: "Checked against the power needed to overcome drag at that speed." },
  { key: "drivetrainTorqueLimitNm", label: "Drivetrain torque rating", quantity: "torque", digits: 0, help: "Rated input torque of the transmission/driveline, if known. Enables a mechanical check." },
  { key: "tireSpeedRatingMs", label: "Tire speed rating", quantity: "speed", digits: 0, help: "e.g. V = 149 mph (240 km/h), W = 168 mph (270 km/h), Y = 186 mph (300 km/h)." },
];

/** Optional claims and component ratings for the feasibility engine (not physics inputs). */
export default function ConstraintFields({ issues }: { issues: Issue[] }) {
  const { state, dispatch } = useApp();
  const scenario = state.ui.editing;
  const units = state.ui.units;
  const own = state.config.constraints?.[scenario] ?? {};
  const effective = effectiveConstraints(state.config, scenario);
  return (
    <>
      {FIELDS.map((fd) => {
        const value = own[fd.key];
        const inherited = scenario === "modified" && value == null ? effective[fd.key] : null;
        const show = (si: number | null | undefined) => (si == null ? "" : String(Number(toDisplay(fd.quantity, si, units).toFixed(fd.digits))));
        const issue = issues.find((i) => i.scenario === scenario && i.key === (fd.key as never));
        return (
          <Row
            key={fd.key}
            label={fd.label}
            htmlFor={`k-${fd.key}`}
            unit={unitLabel(fd.quantity, units)}
            help={fd.help}
            issue={issue}
            hint={inherited != null ? `Inherited from Stock: ${show(inherited)} ${unitLabel(fd.quantity, units)}` : undefined}
            {...(value != null ? { onReset: () => dispatch({ type: "setConstraint", scenario, key: fd.key, value: null }), resetLabel: "Clear" } : {})}
          >
            <CommitInput
              id={`k-${fd.key}`}
              value={show(value)}
              placeholder="Optional"
              invalid={issue?.severity === "error"}
              className="pr-14"
              onCommit={(t) => {
                const s = t.trim().replace(/,/g, "");
                if (!s) return dispatch({ type: "setConstraint", scenario, key: fd.key, value: null });
                const n = Number(s);
                if (Number.isFinite(n)) dispatch({ type: "setConstraint", scenario, key: fd.key, value: fromDisplay(fd.quantity, n, units) });
              }}
            />
          </Row>
        );
      })}
    </>
  );
}
