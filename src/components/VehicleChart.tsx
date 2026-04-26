"use client";

import {
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SimulationPoint } from "@/lib/vehicleTypes";

type VehicleChartProps = {
  data: SimulationPoint[];
  hasModification: boolean;
};

export default function VehicleChart({
  data,
  hasModification,
}: VehicleChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex h-[420px] min-h-[420px] w-full min-w-0 items-center justify-center rounded-3xl border border-violet-500/20 bg-[#100d1c] p-5 text-neutral-400">
        Run a performance analysis to generate graph data.
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-violet-500/20 bg-white/[0.03] p-6">
      <div className="mb-5">
        <h2 className="text-2xl font-black">Acceleration Curve</h2>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          Vehicle speed over time. The modified curve only appears when Modified
          HP is different from Stock HP.
        </p>
      </div>

      <div className="h-[380px] min-h-[380px] w-full min-w-0 overflow-hidden rounded-3xl border border-violet-500/20 bg-[#100d1c] p-5">
        <ResponsiveContainer
          width="100%"
          height={340}
          minWidth={300}
          minHeight={300}
        >
          <LineChart data={data}>
            <XAxis
              dataKey="time"
              stroke="#a3a3a3"
              label={{
                value: "Time (seconds)",
                position: "insideBottom",
                offset: -5,
                fill: "#a3a3a3",
              }}
            />
            <YAxis
              stroke="#a3a3a3"
              label={{
                value: "Speed (mph)",
                angle: -90,
                position: "insideLeft",
                fill: "#a3a3a3",
              }}
            />
            <Tooltip
              contentStyle={{
                background: "#100d1c",
                border: "1px solid rgba(139,92,246,0.35)",
                borderRadius: "16px",
                color: "white",
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="stockSpeedMph"
              name="Stock Speed"
              stroke="#a78bfa"
              strokeWidth={3}
              dot={false}
            />

            {hasModification && (
              <Line
                type="monotone"
                dataKey="modifiedSpeedMph"
                name="Modified Speed"
                stroke="#f0abfc"
                strokeWidth={3}
                dot={false}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}