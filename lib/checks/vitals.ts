import type { SiteSnapshot } from "@/lib/snapshot";
import type { Vitals } from "./performance";

// Core Web Vitals from the browser the audit already runs. PageSpeed is the better source when it is
// available (it names the element and the file), so the browser fills in only what PageSpeed lacks:
// every vital when there is no PageSpeed key, and a lab INP when Google has no field data for the page.

type Rendered = NonNullable<SiteSnapshot["rendered"]>;
type Inp = NonNullable<Vitals["inp"]>;

const ratingOf = (ms: number): Inp["rating"] => (ms <= 200 ? "good" : ms <= 500 ? "needs improvement" : "poor");

function labInp(rendered: Rendered): Inp | null {
  if (rendered.light) return null;
  return rendered.inpMs && rendered.inpMs > 0 ? { ms: rendered.inpMs, rating: ratingOf(rendered.inpMs), source: "lab" } : null;
}

/** Vitals measured by the audit's own browser, or null when it reported no largest paint. */
export function browserVitals(rendered: Rendered | undefined): Vitals | null {
  // A page measured with its images and styles blocked has no meaningful paint or shift numbers.
  if (!rendered || rendered.light || !rendered.lcpMs || rendered.lcpMs <= 0) return null;
  return {
    source: "browser",
    lcp: { ms: rendered.lcpMs, element: rendered.lcpTag ? `${rendered.lcpTag} element` : null, resource: null },
    cls: { value: (rendered.clsMilli ?? 0) / 1000, shifts: [] },
    inp: labInp(rendered),
    blockers: [],
    heavyScripts: [],
  };
}

export function mergeBrowserVitals(psi: Vitals | null, rendered: Rendered | undefined): Vitals | null {
  if (!psi) return browserVitals(rendered);
  if (psi.inp || !rendered) return psi;
  const inp = labInp(rendered);
  return inp ? { ...psi, inp } : psi;
}
