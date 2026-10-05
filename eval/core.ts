import { runScan, type RunDeps } from "@/lib/pipeline/run";
import { FindingSchema, type Report } from "@/lib/pipeline/schemas";
import type { PageFetcher } from "@/lib/snapshot";
import type { SafeResponse } from "@/lib/safe-fetch";
import type { Fixture } from "./fixtures";
import type { Truth } from "./ground-truth";

// Runs the real scan pipeline over the fixture sites, with no AI, no PageSpeed and no network, so
// the result depends only on the deterministic checks and is the same every time.

export interface Scorecard {
  fixtures: number;
  expectedFindings: number;
  foundExpected: number;
  /** Share of the seeded problems that were found. */
  recall: number;
  /** Findings that appeared where they must not (an `absent` finding, or any finding on an exact fixture). */
  falsePositives: number;
  /** Every finding on every fixture passes the schema, including at least one piece of evidence. */
  evidenceValid: boolean;
  /** Two runs over every fixture give the same findings and scores. */
  deterministic: boolean;
  failures: string[];
}

const CHECKED = new Set(["technical", "geo", "content", "social"]);

export function fixtureFetcher(fixture: Fixture, name: string): PageFetcher {
  return async (url): Promise<SafeResponse> => {
    const u = new URL(url);
    const file = u.hostname === `${name}.test` ? fixture.files[u.pathname] : undefined;
    if (!file) {
      return { url, finalUrl: url, status: 404, headers: {}, contentType: "text/html", body: "not found", truncated: false };
    }
    const contentType = file.contentType ?? "text/html";
    return { url, finalUrl: url, status: file.status ?? 200, headers: { ...file.headers, "content-type": contentType }, contentType, body: file.body, truncated: false };
  };
}

async function scan(name: string, fixture: Fixture, overrides: Pick<RunDeps, "modules">): Promise<Report> {
  return runScan(new URL(`https://${name}.test/`), {
    fetchPage: fixtureFetcher(fixture, name),
    emit: () => {},
    newId: () => "eval",
    ...overrides,
  });
}

const findingIds = (r: Report) => r.modules.filter((m) => CHECKED.has(m.module)).flatMap((m) => m.findings.map((f) => f.id)).sort();
const fingerprint = (r: Report) => JSON.stringify({ ids: findingIds(r), scores: r.modules.map((m) => [m.module, m.score]), overall: r.overallScore });

export async function runEval(
  fixtures: Record<string, Fixture>,
  truth: Record<string, Truth>,
  overrides: Pick<RunDeps, "modules"> = {},
): Promise<Scorecard> {
  const card: Scorecard = { fixtures: Object.keys(fixtures).length, expectedFindings: 0, foundExpected: 0, recall: 0, falsePositives: 0, evidenceValid: true, deterministic: true, failures: [] };

  for (const [name, fixture] of Object.entries(fixtures)) {
    const t = truth[name];
    if (!t) {
      card.failures.push(`${name}: no ground truth`);
      continue;
    }

    if (t.error) {
      card.expectedFindings += 1;
      const error = await scan(name, fixture, overrides).then(() => null, (e: Error) => e);
      if (error?.constructor.name === t.error) card.foundExpected += 1;
      else card.failures.push(`${name}: expected ${t.error}, got ${error ? error.constructor.name : "a report"}`);
      continue;
    }

    const first = await scan(name, fixture, overrides);
    const second = await scan(name, fixture, overrides);
    if (fingerprint(first) !== fingerprint(second)) {
      card.deterministic = false;
      card.failures.push(`${name}: two runs gave different results`);
    }

    for (const m of first.modules) {
      for (const f of m.findings) {
        if (!FindingSchema.safeParse(f).success) {
          card.evidenceValid = false;
          card.failures.push(`${name}: ${f.id} has no valid evidence`);
        }
      }
    }

    const found = new Set(findingIds(first));
    card.expectedFindings += t.expect.length;
    for (const id of t.expect) {
      if (found.has(id)) card.foundExpected += 1;
      else card.failures.push(`${name}: missing ${id}`);
    }
    for (const id of t.absent ?? []) {
      if (found.has(id)) {
        card.falsePositives += 1;
        card.failures.push(`${name}: unexpected ${id}`);
      }
    }
    if (t.exact) {
      for (const id of found) {
        if (!t.expect.includes(id) && !(t.absent ?? []).includes(id)) {
          card.falsePositives += 1;
          card.failures.push(`${name}: unexpected ${id}`);
        }
      }
    }
  }

  card.recall = card.expectedFindings === 0 ? 1 : card.foundExpected / card.expectedFindings;
  return card;
}
