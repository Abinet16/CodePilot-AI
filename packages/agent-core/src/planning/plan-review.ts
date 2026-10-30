import type { ImplementationPlan } from "@codepilot/contracts";
import { PathPolicyError, normalizeRelativePath } from "../path-policy";

export type PlanReview = { ok: true; plan: ImplementationPlan } | { ok: false; problems: string[] };

/**
 * Checks the model's affected files against the path policy and the pinned
 * commit's file list. Accepted paths are returned normalized, so later stages
 * only ever see the canonical form.
 */
export function reviewPlanPaths(plan: ImplementationPlan, existingPaths: ReadonlySet<string>): PlanReview {
  const problems: string[] = [];
  const seen = new Set<string>();
  const affectedFiles: ImplementationPlan["affectedFiles"] = [];

  for (const file of plan.affectedFiles) {
    let path: string;
    try {
      path = normalizeRelativePath(file.path);
    } catch (err) {
      if (!(err instanceof PathPolicyError)) throw err;
      problems.push(`${JSON.stringify(file.path)} is not a path the agent may change (${err.violation.replace(/_/g, " ")}).`);
      continue;
    }

    if (seen.has(path)) {
      problems.push(`${path} is listed more than once.`);
      continue;
    }
    seen.add(path);

    const exists = existingPaths.has(path);
    if (file.change === "create" && exists) problems.push(`${path} already exists; use "modify" instead of "create".`);
    if (file.change !== "create" && !exists) {
      problems.push(`${path} does not exist at the pinned commit; use "create" for a new file, or correct the path.`);
    }
    affectedFiles.push({ ...file, path });
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, plan: { ...plan, affectedFiles } };
}
