type StatCardProps = {
  label: string;
  value: string;
  status?: "PASS" | "CHECK" | "UNKNOWN";
};

export default function StatCard({ label, value, status }: StatCardProps) {
  const statusClass =
    status === "PASS"
      ? "bg-green-500/15 text-green-300"
      : status === "CHECK"
        ? "bg-yellow-500/15 text-yellow-300"
        : "bg-neutral-500/15 text-neutral-300";

  return (
    <div className="rounded-3xl border border-violet-500/20 bg-white/[0.03] p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">{label}</p>

        {status && (
          <span className={`rounded-full px-3 py-1 text-xs font-black ${statusClass}`}>
            {status}
          </span>
        )}
      </div>

      <p className="mt-3 text-3xl font-black text-violet-300">{value}</p>
    </div>
  );
}