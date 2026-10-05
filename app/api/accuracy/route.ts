import { readScorecards } from "@/lib/accuracy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The deploy workflow calls this to check the app came back, as RepoRecon's deploy does with its own
// /api/accuracy. It answers even when the scorecards are missing; the page then says so.
export function GET() {
  const { eval: scorecard, adversarial } = readScorecards();
  return Response.json({
    ok: true,
    eval: scorecard && {
      fixtures: scorecard.fixtures, seededProblems: scorecard.expectedFindings, found: scorecard.foundExpected,
      recall: scorecard.recall, falsePositives: scorecard.falsePositives, ranOn: scorecard.ranOn,
    },
    adversarial: adversarial && { total: adversarial.total, passed: adversarial.passed, ranOn: adversarial.ranOn },
  });
}
