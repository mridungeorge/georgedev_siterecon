import Link from "next/link";
import { rubricTable } from "@/lib/methodology";

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
        <h2 className="text-xl font-semibold">Where the data goes</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
          <li>Your site is fetched by SiteRecon itself, respecting robots.txt, with the user agent <code>SiteReconBot</code>.</li>
          <li>Text from your homepage is sent to a free AI service (NVIDIA or Google) for the content review and the marketing ideas.</li>
          <li>Your site address is sent to Google PageSpeed Insights for the speed measurements.</li>
          <li>Public social profile addresses are sent to a reader service (Jina Reader) so the pages can be opened without logging in.</li>
          <li>Your domain is sent to the Hacker News search to count public mentions, and to an optional web search to find competitors.</li>
          <li>Reports are stored for 30 days, and a repeat scan of the same site within 24 hours reuses the stored report.</li>
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
