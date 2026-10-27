export interface CheckOutcome {
  passed: boolean;
  /** Set when a check tripped a safety boundary (timeout, resource limit, policy violation). */
  safetyViolation?: string;
}

export type RepairDecision =
  | { action: "ready_for_review" }
  | { action: "repair"; attempt: number }
  | { action: "fail"; reason: string };

/**
 * Decides what happens after a verification run. Repairs are bounded so a
 * task can never loop indefinitely spending tokens and sandbox time.
 */
export function decideAfterChecks(outcome: CheckOutcome, repairsSoFar: number, maxRepairs: number): RepairDecision {
  if (outcome.safetyViolation) {
    return { action: "fail", reason: `Safety boundary violated: ${outcome.safetyViolation}` };
  }
  if (outcome.passed) return { action: "ready_for_review" };
  if (repairsSoFar >= maxRepairs) {
    return { action: "fail", reason: `Checks still failing after ${repairsSoFar} repair attempt(s)` };
  }
  return { action: "repair", attempt: repairsSoFar + 1 };
}
