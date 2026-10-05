import Link from "next/link";
import { readScorecards } from "@/lib/accuracy";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accuracy · SiteRecon", description: "How SiteRecon is tested, and what those tests do and do not show." };

export default function AccuracyPage() {
  const { eval: card, adversarial } = readScorecards();

  return (
    <main className="mx-auto max-w-3xl px-4 py-16 sm:py-24">
      <p className="mb-3 text-xs uppercase tracking-widest text-[var(--muted)]"><Link href="/">SiteRecon</Link> · accuracy</p>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">How SiteRecon is tested</h1>
      <p className="mt-4 text-[var(--muted)]">
        Every change is checked by running the real audit over a set of small websites built to contain known problems, and the check fails if it
        misses them or reports problems that are not there. These are the results that were committed with this version of the code.
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Seeded problems</h2>
        {card ? (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Test sites", String(card.fixtures)],
                ["Problems found", `${card.foundExpected} of ${card.expectedFindings}`],
                ["False alarms", String(card.falsePositives)],
                ["Recall", `${(card.recall * 100).toFixed(1)}%`],
              ].map(([label, value]) => (
                <div key={label} className="border border-[var(--line)] bg-[var(--surface)] p-4">
                  <dt className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-4 space-y-1 text-sm">
              <li>{card.evidenceValid ? "✓" : "✗"} Every finding carries evidence from the page.</li>
              <li>{card.deterministic ? "✓" : "✗"} Running the same site twice gives the same result.</li>
              <li className="text-[var(--muted)]">Last run {card.ranOn}. The build fails below {(card.recallFloor * 100).toFixed(0)}% recall or on any false alarm.</li>
            </ul>
            {card.failures.length > 0 && (
              <ul className="mt-3 list-disc pl-5 text-sm text-[var(--bad)]">{card.failures.map((f) => <li key={f}>{f}</li>)}</ul>
            )}
          </>
        ) : (
          <p className="mt-3 text-sm">The scorecard has not been generated on this server yet, so there are no numbers to show.</p>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">What these numbers do not show</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
          <li>
            {card ? `The ${card.fixtures} test sites` : "The test sites"} are small pages built for the test. They are not a sample of the real web, so
            full marks here means the checks do what they say, not that every report about your site is right.
          </li>
          <li>Only the fixed checks are measured. The AI review, PageSpeed, social profile reads and competitor comparison need live services and are not part of this score.</li>
          <li>The AI review can move the content score by at most 20 points, and only with a quote from your page. That bound is tested below.</li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Attacks on the tool itself</h2>
        {adversarial ? (
          <>
            <p className="mt-2 text-sm">{adversarial.passed} of {adversarial.total} cases held (last run {adversarial.ranOn}).</p>
            <ul className="mt-3 space-y-1 text-sm">
              {adversarial.cases.map((c) => <li key={c.name}>{c.passed ? "✓" : "✗"} {c.name}</li>)}
            </ul>
          </>
        ) : (
          <p className="mt-3 text-sm">The adversarial results have not been generated on this server yet.</p>
        )}
      </section>

      <p className="mt-12 text-sm text-[var(--muted)]"><Link href="/methodology" className="underline">What is checked and how it is scored →</Link></p>
    </main>
  );
}
