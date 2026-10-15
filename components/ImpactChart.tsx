import type { Finding } from "@/lib/pipeline/schemas";
import { layoutImpactChart } from "@/lib/impact-chart";

// Every finding as one numbered dot on an impact (up) against effort (right) chart. The text of a
// finding comes from the audited site or a model, so it is only ever drawn as text.

const W = 560;
const H = 320;
const FILL: Record<Finding["severity"], string> = { critical: "#ef4444", high: "#fb923c", medium: "#facc15", low: "#38bdf8" };

export default function ImpactChart({ findings }: { findings: Finding[] }) {
  const { dots, radius } = layoutImpactChart(findings, W, H);
  if (dots.length === 0) return null;
  return (
    <figure className="mt-3">
      <svg viewBox={`-34 -8 ${W + 44} ${H + 40}`} role="img" aria-labelledby="impact-title impact-desc" className="w-full max-w-2xl text-ink-soft">
        <title id="impact-title">Impact against effort</title>
        <desc id="impact-desc">
          {dots.length} findings placed by impact (up) and effort (right). Top left holds quick wins, top right big bets, bottom left fill-ins and bottom right the ones to leave until last.
        </desc>
        <rect x={0} y={0} width={W} height={H} fill="none" stroke="currentColor" strokeOpacity={0.35} />
        <line x1={W / 2} y1={0} x2={W / 2} y2={H} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="4 4" />
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="currentColor" strokeOpacity={0.35} strokeDasharray="4 4" />
        <text x={W - 6} y={14} fontSize={11} textAnchor="end" fill="currentColor" fillOpacity={0.6}>Big bets</text>
        <text x={6} y={14} fontSize={11} fill="currentColor" fillOpacity={0.6}>Quick wins</text>
        <text x={6} y={H - 6} fontSize={11} fill="currentColor" fillOpacity={0.6}>Fill-ins</text>
        <text x={W - 6} y={H - 6} fontSize={11} textAnchor="end" fill="currentColor" fillOpacity={0.6}>Deprioritise</text>
        <text x={W / 2} y={H + 18} fontSize={11} textAnchor="middle" fill="currentColor">Effort →</text>
        <text x={-14} y={H / 2} fontSize={11} textAnchor="middle" fill="currentColor" transform={`rotate(-90 -14 ${H / 2})`}>Impact →</text>
        {dots.map((d) => (
          <g key={d.id}>
            <title>{`${d.n}. ${d.title}`}</title>
            <circle cx={d.x} cy={d.y + 8} r={radius} fill={FILL[d.severity]} fillOpacity={0.9} />
            <text x={d.x} y={d.y + 8 + radius * 0.35} fontSize={radius * 0.95} textAnchor="middle" fill="#111" fontWeight={600}>{d.n}</text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-2">
        <ol className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-muted sm:grid-cols-2">
          {dots.map((d) => (
            <li key={d.id} className="break-words"><span className="text-ink-soft">{d.n}.</span> {d.title}</li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}
