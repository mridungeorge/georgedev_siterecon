// The scan pipeline, drawn from the same step list the app runs. Static SVG: no scripts, no external data.
const STAGES: { label: string; sub: string; optional?: boolean }[] = [
  { label: "fetch", sub: "safeFetch, robots.txt" },
  { label: "render", sub: "Chromium", optional: true },
  { label: "seo", sub: "rules" },
  { label: "ai visibility", sub: "rules" },
  { label: "crawl", sub: "rules, raw vs rendered" },
  { label: "citation", sub: "rules + quoted AI" },
  { label: "content", sub: "rules + quoted AI" },
  { label: "marketing", sub: "rules + quoted AI" },
  { label: "speed", sub: "PageSpeed", optional: true },
  { label: "social", sub: "public pages", optional: true },
  { label: "competitors", sub: "same checks", optional: true },
  { label: "report", sub: "scores in code" },
];

export default function PipelineDiagram() {
  const w = 150;
  const gap = 18;
  const perRow = 5;
  const rows = Math.ceil(STAGES.length / perRow);
  const width = perRow * w + (perRow - 1) * gap;
  const height = rows * 64 + (rows - 1) * 30;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="pipeline-title pipeline-desc" className="mt-4 w-full">
      <title id="pipeline-title">The SiteRecon scan pipeline</title>
      <desc id="pipeline-desc">
        Twelve steps run in order: fetch, render, seo, ai visibility, crawl, citation, content, marketing, speed, social, competitors, report. Only fetch can fail a scan.
        Dashed boxes are optional and are reported as could not check when their service is missing.
      </desc>
      <defs>
        <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="currentColor" fillOpacity={0.6} />
        </marker>
      </defs>
      {STAGES.map((s, i) => {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        const x = col * (w + gap);
        const y = row * 94;
        return (
          <g key={s.label}>
            <rect x={x} y={y} width={w} height={64} rx={6} fill="none" stroke="currentColor" strokeOpacity={s.optional ? 0.45 : 0.9} strokeDasharray={s.optional ? "5 4" : undefined} />
            <text x={x + 12} y={y + 26} fontSize={14} fontWeight={600} fill="currentColor">{`${String(i + 1).padStart(2, "0")} ${s.label}`}</text>
            <text x={x + 12} y={y + 46} fontSize={11} fill="currentColor" fillOpacity={0.65}>{s.sub}</text>
            {col < perRow - 1 && <path d={`M${x + w + 2} ${y + 32} h${gap - 4}`} stroke="currentColor" strokeOpacity={0.6} markerEnd="url(#arrow)" />}
          </g>
        );
      })}
    </svg>
  );
}
