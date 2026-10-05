import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAdversarial } from "./adversarial";

// `npm run eval:adversarial`. Writes eval/adversarial-scorecard.json and exits non-zero if any case fails.
async function main(): Promise<void> {
  const card = await runAdversarial();
  const file = join(process.cwd(), "eval", "adversarial-scorecard.json");
  writeFileSync(file, JSON.stringify({ ...card, ranOn: new Date().toISOString().slice(0, 10) }, null, 2) + "\n");

  for (const c of card.cases) console.log(`${c.passed ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  console.log(`${card.passed}/${card.total} adversarial cases held`);
  if (card.failed.length > 0) {
    console.error("Adversarial gate FAILED");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
