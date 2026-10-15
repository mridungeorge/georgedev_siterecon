import Link from "next/link";
import { rubricTable } from "@/lib/methodology";
import { READINESS_COMPONENTS } from "@/lib/ai-readiness";
import PipelineDiagram from "@/components/PipelineDiagram";

export const dynamic = "force-dynamic";
export const metadata = { title: "Methodology · SiteRecon", description: "Everything SiteRecon checks, how it is scored and where the data comes from." };

export default async function MethodologyPage() {
  const table = await rubricTable();

  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <p className="mb-3 text-xs uppercase tracking-widest text-[var(--muted)]"><Link href="/">SiteRecon</Link> · methodology</p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">What is checked, and how it is scored</h1>
      <p className="mt-4 text-[var(--muted)]">
        A module score is the share of its check weight that passed, worked out in code. The overall score is the weighted mean of the modules
        that could be measured. A model never sets a score. This page is generated from the checks themselves, so it cannot drift from them.
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">AI Readiness Score</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          A second headline number: how ready the site is to be found, read and quoted by AI search. It is a lens over the checks below, so it adds
          no checks of its own, and no model sets it. A check that did not run is left out and the remaining weights are rescaled.
        </p>
        <table className="mt-3 w-full border-collapse text-sm">
          <tbody>
            {READINESS_COMPONENTS.map((c) => (
              <tr key={c.id} className="border-b border-[var(--line)] align-top">
                <td className="py-2 pr-4">
                  {c.label}
                  <div className="text-xs text-[var(--muted)]">{c.members.map((m) => `${m.module}:${m.id}`).join(", ")}</div>
                </td>
                <td className="w-16 py-2 text-right tabular-nums text-[var(--muted)]">{c.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-[var(--muted)]">Bands: 80 and over Strong, 60 to 79 Moderate, 40 to 59 Weak, below 40 Very weak.</p>
      </section>

      {table.map((m) => (
        <section key={m.module} className="mt-10">
          <h2 className="text-xl font-semibold">{m.label} <span className="text-sm font-normal text-[var(--muted)]">· {m.weightInOverall}% of the overall score</span></h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{m.source}</p>
          <table className="mt-3 w-full border-collapse text-sm">
            <tbody>
              {m.checks.map((c) => (
                <tr key={c.id} className="border-b border-[var(--line)]">
                  <td className="py-2 pr-4">{c.label}{c.ai && <span className="ml-2 text-xs uppercase tracking-wide text-[var(--warn)]">AI, must quote the page</span>}</td>
                  <td className="w-16 py-2 text-right tabular-nums text-[var(--muted)]">{c.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="mt-10">
        <h2 className="text-xl font-semibold">How a scan runs</h2>
        <PipelineDiagram />
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm">
          <li><strong>Deterministic scoring.</strong> Every score is a share of fixed check weight, worked out in code. A model may explain or suggest. It never scores, and anything it claims must quote the page.</li>
          <li><strong>Graceful degradation.</strong> Only the fetch step can fail a scan. If the AI, PageSpeed or the browser is unavailable, that part says &quot;could not check&quot; and the full deterministic report still arrives.</li>
          <li><strong>Defence in depth.</strong> URL allowlist, connect-time address checks against private ranges, size, time and redirect caps, robots.txt, per-visitor and per-site rate limits, and a container firewall around the browser.</li>
          <li><strong>Bounded work.</strong> Each outside-service step has its own time budget, and the whole scan has a nine-minute ceiling.</li>
          <li><strong>Observable.</strong> Every report records how long each step took and how it ended. See <Link href="/telemetry" className="underline">telemetry</Link>.</li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Where the data goes</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
          <li>
            Your pages are fetched by SiteRecon itself with the user agent <code>SiteReconBot</code>, respecting robots.txt. The optional browser step
            then opens your homepage in Chromium, which identifies itself as an ordinary browser and does not check robots.txt for the files the page
            itself loads.
          </li>
          <li>Text from your homepage is sent to a free AI service (NVIDIA or Google) for the content review, to name competitors, and to suggest marketing ideas.</li>
          <li>Your site address is sent to Google PageSpeed Insights for the speed measurements.</li>
          <li>
            Public social profile addresses are opened through GitHub&apos;s public API, yt-dlp (for YouTube) and Jina Reader (for everything else),
            so they can be read without logging in.
          </li>
          <li>Your domain is sent to the Hacker News search to count public mentions, and to an optional web search (Tavily) to find competitors.</li>
          <li>
            Up to three competitor sites that the AI names are fetched (their homepage, robots.txt, sitemap and llms.txt), at most three times an
            hour for any one site. The AI chooses them from your page, so treat them as suggestions.
          </li>
          <li>Reports are stored for 30 days, and a repeat scan of the same site within 24 hours reuses the stored report. Each finished scan is also logged, with your domain as a label, in a private MLflow.</li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">What SiteRecon will not do</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
          <li>Log in to any platform. Pages that need a login are listed as not checked.</li>
          <li>Get around a site that blocks crawlers or serves a bot challenge. That is reported, and the site is not scanned.</li>
          <li>Scan private or internal addresses.</li>
          <li>Present the AI&apos;s opinion as a measurement. Anything the AI says must quote your page or it is dropped.</li>
        </ul>
        <p className="mt-6 text-sm text-[var(--muted)]"><Link href="/accuracy" className="underline">How these checks are tested →</Link></p>
      </section>
    </main>
  );
}
