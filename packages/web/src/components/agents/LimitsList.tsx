import type { KeyLimits } from "@/lib/agentKeys";

export function LimitsList({ limits }: { limits: KeyLimits }) {
  const rows: Array<[label: string, value: string]> = [
    ["Guest boards a day", String(limits.runsPerDay)],
    ["Show searches a day", String(limits.findsPerDay)],
    ["Briefs a day", String(limits.briefsPerDay)],
    ["Calls in flight at once", String(limits.inflightPerKey)],
    ["The key lasts", `${limits.keyLifeDays} days`],
  ];

  return (
    <div className="mt-8">
      <dl className="divide-y divide-rule">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[1fr_auto] items-baseline py-3">
            <dt className="font-body text-[15px] text-rice-dim">{label}</dt>
            <dd className="font-mono text-[14px] text-rice">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 font-body text-[14px] text-rice-dim">
        {`Agents use their own daily share, never the website's. One network can get ${limits.keysPerVisitorPerDay} keys a day.`}
      </p>
    </div>
  );
}
