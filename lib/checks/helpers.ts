import type { CheckOutcome, Finding, ModuleName } from "@/lib/pipeline/schemas";

/** Collects weighted pass/fail outcomes for one module. A failure must describe itself as a finding. */
export function makeChecker(module: ModuleName) {
  const outcomes: CheckOutcome[] = [];
  return {
    outcomes,
    check(id: string, weight: number, ok: boolean, onFail: Omit<Finding, "id" | "module">): void {
      outcomes.push(ok ? { id, weight, passed: true } : { id, weight, passed: false, finding: { id: `${module}:${id}`, module, ...onFail } });
    },
  };
}

/** Shortens page text before it is quoted as evidence. */
export function clip(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
