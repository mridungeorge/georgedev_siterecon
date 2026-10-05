import { describe, it, expect } from "vitest";
import { runEval } from "../eval/core";
import { runAdversarial } from "../eval/adversarial";
import { FIXTURES } from "../eval/fixtures";
import { TRUTH } from "../eval/ground-truth";

// These are the same floors the CI gate (npm run eval) enforces.
const RECALL_FLOOR = 0.95;

describe("eval harness: accuracy on the hand-built fixture sites", () => {
  it("has a ground truth for every fixture and the other way round", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(TRUTH).sort());
    expect(Object.keys(FIXTURES).length).toBeGreaterThanOrEqual(9);
  });

  it("finds the problems that are seeded in the fixtures and reports nothing it should not", async () => {
    const card = await runEval(FIXTURES, TRUTH);
    expect(card.failures).toEqual([]);
    expect(card.recall).toBeGreaterThanOrEqual(RECALL_FLOOR);
    expect(card.falsePositives).toBe(0);
    expect(card.evidenceValid).toBe(true);
    expect(card.deterministic).toBe(true);
    expect(card.expectedFindings).toBeGreaterThan(40);
  });

  it("fails loudly when a check stops working, so the CI gate has teeth", async () => {
    const card = await runEval(FIXTURES, TRUTH, { modules: { technical: () => [] } });
    expect(card.recall).toBeLessThan(RECALL_FLOOR);
    expect(card.failures.length).toBeGreaterThan(0);
  });

  it("fails when a check starts reporting problems that are not there", async () => {
    const noisy = (): never[] => [];
    const card = await runEval(FIXTURES, TRUTH, { modules: { geo: noisy } });
    expect(card.failures.length).toBeGreaterThan(0);
  });
});

describe("adversarial set: attacks on the tool itself", () => {
  it("withstands every case", async () => {
    const card = await runAdversarial();
    expect(card.failed).toEqual([]);
    expect(card.total).toBeGreaterThanOrEqual(8);
    expect(card.passed).toBe(card.total);
  });
});
