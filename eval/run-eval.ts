import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runEval } from "./core";
import { FIXTURES } from "./fixtures";
import { TRUTH } from "./ground-truth";

// `npm run eval`. Writes eval/scorecard.json (shown on the /accuracy page) and exits non-zero if the
// accuracy drops below the floor. CI runs this on every push, like RepoRecon's eval gate.
const RECALL_FLOOR = 0.95;

async function main(): Promise<void> {
  const card = await runEval(FIXTURES, TRUTH);
  const file = join(process.cwd(), "eval", "scorecard.json");
  writeFileSync(file, JSON.stringify({ ...card, ranOn: new Date().toISOString().slice(0, 10), recallFloor: RECALL_FLOOR }, null, 2) + "\n");

  console.log(`fixtures ${card.fixtures} | seeded problems found ${card.foundExpected}/${card.expectedFindings} (recall ${(card.recall * 100).toFixed(1)}%) | false positives ${card.falsePositives} | evidence valid ${card.evidenceValid} | deterministic ${card.deterministic}`);
  for (const failure of card.failures) console.log("  FAIL", failure);

  // Any failure at all fails the gate, including a fixture with no ground truth.
  if (card.recall < RECALL_FLOOR || card.falsePositives > 0 || !card.evidenceValid || !card.deterministic || card.failures.length > 0) {
    console.error("Eval gate FAILED");
    process.exit(1);
  }
  console.log("Eval gate passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
