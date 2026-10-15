import type { Finding } from "@/lib/pipeline/schemas";
import { buildImpactMatrix } from "@/lib/impact-matrix";

// Positions for an impact (up) against effort (right) chart. Each finding is one numbered dot inside
// its quadrant. Only layout lives here, so it can be tested without drawing anything.

export interface ChartDot {
  /** 1-based, in the order the legend lists the findings. */
  n: number;
  id: string;
  title: string;
  severity: Finding["severity"];
  x: number;
  y: number;
}

export interface ImpactChartLayout {
  dots: ChartDot[];
  radius: number;
}

export function layoutImpactChart(findings: Finding[], width: number, height: number): ImpactChartLayout {
  const m = buildImpactMatrix(findings);
  // The order in each quadrant is the matrix order: most severe first, then cheapest first.
  const quadrants: { list: Finding[]; left: number; top: number }[] = [
    { list: m.quickWins, left: 0, top: 0 },
    { list: m.bigBets, left: width / 2, top: 0 },
    { list: m.fillIns, left: 0, top: height / 2 },
    { list: m.deprioritise, left: width / 2, top: height / 2 },
  ];
  const qw = width / 2;
  const qh = height / 2;
  // The largest dot that lets the fullest quadrant fit in its own box with a gap between dots.
  const biggest = Math.max(1, ...quadrants.map((q) => q.list.length));
  let radius = Math.min(14, qw / 6, qh / 6);
  const fits = (r: number) => {
    const step = r * 2.4;
    const cols = Math.max(1, Math.floor((qw - r) / step));
    const rows = Math.max(1, Math.floor((qh - r) / step));
    return cols * rows >= biggest;
  };
  while (radius > 2 && !fits(radius)) radius -= 0.5;

  const step = radius * 2.4;
  const cols = Math.max(1, Math.floor((qw - radius) / step));
  const dots: ChartDot[] = [];
  let n = 0;
  for (const q of quadrants) {
    q.list.forEach((finding, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      n += 1;
      dots.push({
        n,
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
        x: q.left + radius + 4 + col * step,
        y: q.top + radius + 4 + row * step,
      });
    });
  }
  // Number in reading order (quick wins first), which is the order dots were pushed.
  return { dots, radius };
}
