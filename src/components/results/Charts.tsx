"use client";

import { useMemo, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useReducedMotion } from "@/components/ui";
import type { ScenarioResult } from "@/lib/physics/analysis";
import { FEASIBILITY_COLORS, SCENARIO_STYLE } from "@/lib/theme";
import { launchAccelBound } from "@/lib/feasibility/bounds";
import { G, toDisplay, unitLabel, type UnitSystem } from "@/lib/units";

const STOCK = SCENARIO_STYLE.stock.color;
const MOD = SCENARIO_STYLE.modified.color;
const GRID = "#2a2e32";
const AXIS = "#7d8288";

const axisProps = { stroke: AXIS, tick: { fill: AXIS, fontSize: 11 }, tickLine: false, axisLine: { stroke: "#3a3f44" } };
const tooltipStyle = {
  contentStyle: { background: "#202428", border: "1px solid #454a50", borderRadius: 5, fontSize: 12, color: "#ece8e1" },
  labelStyle: { color: "#a9adb2", marginBottom: 4 },
  itemStyle: { padding: 0 },
};

export function ChartFrame({ title, caption, children, height = 260 }: { title: string; caption: ReactNode; children: ReactNode; height?: number }) {
  return (
    <figure className="print-plain print-break min-w-0 rounded-lg border border-line bg-surface">
      <figcaption className="border-b border-line px-4 py-3">
        <div className="text-[14px] font-semibold tracking-tight">{title}</div>
        <div className="mt-0.5 text-xs leading-4 text-muted">{caption}</div>
      </figcaption>
      <div className="px-1 pt-3 pb-1 sm:px-2" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 520, height }}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

type Series = { id: "stock" | "modified"; label: string; color: string; r: ScenarioResult };

function useSeries(stock: ScenarioResult | null, modified: ScenarioResult | null): Series[] {
  return useMemo(() => {
    const out: Series[] = [];
    if (stock) out.push({ id: "stock", label: "Stock", color: STOCK, r: stock });
    if (modified) out.push({ id: "modified", label: "Modified", color: MOD, r: modified });
    return out;
  }, [stock, modified]);
}

const thin = <T,>(arr: T[], every: number) => arr.filter((_, i) => i % every === 0);

export function SpeedTimeChart({ stock, modified, units }: { stock: ScenarioResult | null; modified: ScenarioResult | null; units: UnitSystem }) {
  const reduced = useReducedMotion();
  const series = useSeries(stock, modified);
  const speedUnit = unitLabel("speed", units);
  const data = series.map((s) => ({ ...s, points: thin(s.r.samples, 2).map((p) => ({ t: Number(p.t.toFixed(2)), v: Number(toDisplay("speed", p.v, units).toFixed(1)) })) }));
  const qm = series.map((s) => s.r.metrics.quarterMileS).filter((x): x is number => x != null);
  return (
    <ChartFrame title="Speed vs. time" caption={`Full-throttle run from rest, computed by the physics engine. Dashed line marks the quarter-mile finish.`}>
      <LineChart margin={{ top: 4, right: 14, left: 0, bottom: 16 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis type="number" dataKey="t" domain={[0, "dataMax"]} {...axisProps} label={{ value: "Time (s)", position: "insideBottom", offset: -8, fill: AXIS, fontSize: 11 }} />
        <YAxis type="number" dataKey="v" width={44} {...axisProps} label={{ value: speedUnit, angle: -90, position: "insideLeft", offset: 12, fill: AXIS, fontSize: 11 }} />
        <Tooltip {...tooltipStyle} formatter={(v) => [`${v} ${speedUnit}`]} labelFormatter={(t) => `${t} s`} />
        <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} />
        {qm.map((t, i) => (
          <ReferenceLine key={i} x={Number(t.toFixed(2))} stroke={data[i]?.color ?? AXIS} strokeDasharray="3 4" strokeOpacity={0.6} />
        ))}
        {data.map((s) => (
          <Line key={s.id} data={s.points} dataKey="v" name={s.label} stroke={s.color} strokeDasharray={SCENARIO_STYLE[s.id].dash} strokeWidth={2} dot={false} isAnimationActive={!reduced} animationDuration={600} />
        ))}
      </LineChart>
    </ChartFrame>
  );
}

export function AccelChart({ stock, modified, units }: { stock: ScenarioResult | null; modified: ScenarioResult | null; units: UnitSystem }) {
  const reduced = useReducedMotion();
  const series = useSeries(stock, modified);
  const bounds = series.map((s) => ({ id: s.id, label: s.label, color: s.color, g: Number((launchAccelBound(s.r.inputs) / G).toFixed(3)) }));
  const speedUnit = unitLabel("speed", units);
  const data = series.map((s) => ({ ...s, points: thin(s.r.samples, 2).map((p) => ({ v: Number(toDisplay("speed", p.v, units).toFixed(1)), g: Number((p.a / G).toFixed(3)) })) }));
  return (
    <ChartFrame title="Acceleration vs. speed" caption="Longitudinal acceleration in g. Dotted lines: launch traction limit used by the feasibility engine. Flat early sections are traction-limited; dips are gear changes.">
      <LineChart margin={{ top: 4, right: 14, left: 0, bottom: 16 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis type="number" dataKey="v" domain={[0, "dataMax"]} {...axisProps} label={{ value: `Speed (${speedUnit})`, position: "insideBottom", offset: -8, fill: AXIS, fontSize: 11 }} />
        <YAxis type="number" dataKey="g" width={44} {...axisProps} label={{ value: "g", angle: -90, position: "insideLeft", offset: 14, fill: AXIS, fontSize: 11 }} />
        <Tooltip {...tooltipStyle} formatter={(v) => [`${v} g`]} labelFormatter={(v) => `${v} ${speedUnit}`} />
        <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} />
        {bounds.map((b, i) => (
          <ReferenceLine
            key={`limit-${b.id}`}
            y={b.g}
            stroke={b.color}
            strokeOpacity={0.55}
            strokeDasharray="1 4"
            label={{ value: `${b.label} traction limit ${b.g.toFixed(2)} g`, position: i === 0 ? "insideTopRight" : "insideBottomRight", fill: AXIS, fontSize: 10 }}
          />
        ))}
        {data.map((s) => (
          <Line key={s.id} data={s.points} dataKey="g" name={s.label} stroke={s.color} strokeDasharray={SCENARIO_STYLE[s.id].dash} strokeWidth={1.75} dot={false} isAnimationActive={!reduced} animationDuration={600} />
        ))}
      </LineChart>
    </ChartFrame>
  );
}

export function CurveChart({ stock, modified, units }: { stock: ScenarioResult | null; modified: ScenarioResult | null; units: UnitSystem }) {
  const reduced = useReducedMotion();
  const series = useSeries(stock, modified);
  const pUnit = unitLabel("power", units);
  const tUnit = unitLabel("torque", units);
  const ev = series.some((s) => s.r.inputs.powertrain === "ev");
  const data = series.map((s) => ({
    ...s,
    points: s.r.curve.map((c) => ({ rpm: c.rpm, p: Number(toDisplay("power", c.powerKw, units).toFixed(1)), t: Number(toDisplay("torque", c.torqueNm, units).toFixed(1)) })),
  }));
  return (
    <ChartFrame
      title={ev ? "Motor torque & power (modeled)" : "Torque & power vs. rpm (modeled)"}
      caption="Synthesized from rated peaks and their rpm points — the curve the simulation used, not dyno data. Thick lines: power (Stock solid, Modified dashed) · dotted: torque."
    >
      <LineChart margin={{ top: 4, right: 4, left: 0, bottom: 16 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis type="number" dataKey="rpm" domain={["dataMin", "dataMax"]} {...axisProps} label={{ value: ev ? "Motor rpm" : "Engine rpm", position: "insideBottom", offset: -8, fill: AXIS, fontSize: 11 }} />
        <YAxis yAxisId="p" width={44} {...axisProps} label={{ value: pUnit, angle: -90, position: "insideLeft", offset: 12, fill: AXIS, fontSize: 11 }} />
        <YAxis yAxisId="t" orientation="right" width={44} {...axisProps} label={{ value: tUnit, angle: 90, position: "insideRight", offset: 12, fill: AXIS, fontSize: 11 }} />
        <Tooltip {...tooltipStyle} labelFormatter={(r) => `${r} rpm`} />
        <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} />
        {data.flatMap((s) => [
          <Line key={`${s.id}-p`} yAxisId="p" data={s.points} dataKey="p" name={`${s.label} power (${pUnit})`} stroke={s.color} strokeDasharray={SCENARIO_STYLE[s.id].dash} strokeWidth={2} dot={false} isAnimationActive={!reduced} />,
          <Line key={`${s.id}-t`} yAxisId="t" data={s.points} dataKey="t" name={`${s.label} torque (${tUnit})`} stroke={s.color} strokeWidth={1.25} strokeDasharray="2 3" dot={false} isAnimationActive={!reduced} />,
        ])}
      </LineChart>
    </ChartFrame>
  );
}

export function SensitivityChart({ result, label }: { result: ScenarioResult; label: string }) {
  const reduced = useReducedMotion();
  const data = result.sensitivity
    .filter((s) => s.favorable060 != null && s.unfavorable060 != null)
    .map((s) => ({ name: `${s.label} (${s.change})`, better: Number(s.favorable060!.toFixed(3)), worse: Number(s.unfavorable060!.toFixed(3)) }))
    .sort((a, b) => Math.abs(b.worse - b.better) - Math.abs(a.worse - a.better));
  return (
    <ChartFrame
      title={`Sensitivity of 0–60 mph — ${label}`}
      caption="Change in 0–60 time when each input moves by the stated amount. Longer bars = assumptions that matter more."
      height={Math.max(220, data.length * 34 + 60)}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }} barGap={-12} barCategoryGap={8}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" {...axisProps} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v}s`} />
        <YAxis type="category" dataKey="name" width={150} {...axisProps} tick={{ fill: "#a9adb2", fontSize: 11 }} />
        <ReferenceLine x={0} stroke="#5a6066" />
        <Tooltip {...tooltipStyle} cursor={{ fill: "rgba(255,255,255,0.03)" }} formatter={(v) => [`${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)} s`]} />
        <Bar dataKey="better" name="Favorable change" fill={FEASIBILITY_COLORS.feasible} barSize={12} isAnimationActive={!reduced} />
        <Bar dataKey="worse" name="Unfavorable change" fill={FEASIBILITY_COLORS.insufficient_data} barSize={12} isAnimationActive={!reduced} />
      </BarChart>
    </ChartFrame>
  );
}

export function MassSweepChart({ stock, modified, units }: { stock: ScenarioResult | null; modified: ScenarioResult | null; units: UnitSystem }) {
  const reduced = useReducedMotion();
  const series = useSeries(stock, modified);
  const data = series.map((s) => ({ ...s, points: s.r.massSweep.filter((p) => p.zeroTo60S != null).map((p) => ({ d: p.deltaPct, t: Number(p.zeroTo60S!.toFixed(2)), m: Math.round(toDisplay("mass", p.massKg, units)) })) }));
  return (
    <ChartFrame title="Impact of mass on 0–60 mph" caption="Each point is a separate simulation with curb mass changed by the given percentage; everything else held constant.">
      <LineChart margin={{ top: 4, right: 14, left: 0, bottom: 16 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis type="number" dataKey="d" domain={[-20, 20]} ticks={[-20, -10, 0, 10, 20]} {...axisProps} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v}%`} label={{ value: "Curb mass change", position: "insideBottom", offset: -8, fill: AXIS, fontSize: 11 }} />
        <YAxis type="number" dataKey="t" width={44} domain={["auto", "auto"]} {...axisProps} label={{ value: "0–60 s", angle: -90, position: "insideLeft", offset: 12, fill: AXIS, fontSize: 11 }} />
        <ReferenceLine x={0} stroke="#5a6066" />
        <Tooltip {...tooltipStyle} formatter={(v) => [`${v} s`]} labelFormatter={(d) => `${Number(d) > 0 ? "+" : ""}${d}% mass`} />
        <Legend verticalAlign="top" height={24} wrapperStyle={{ fontSize: 12 }} />
        {data.map((s) => (
          <Line key={s.id} data={s.points} dataKey="t" name={s.label} stroke={s.color} strokeDasharray={SCENARIO_STYLE[s.id].dash} strokeWidth={2} dot={s.id === "modified" ? { r: 3, strokeWidth: 0, fill: s.color } : { r: 2.5 }} isAnimationActive={!reduced} />
        ))}
      </LineChart>
    </ChartFrame>
  );
}
