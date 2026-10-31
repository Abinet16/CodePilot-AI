import type { ImplementationPlan, PatchFileStat, PatchProposal, PlanFileChange } from "@codepilot/contracts";
import { PathPolicyError, normalizeRelativePath } from "../path-policy";
import { applyEdits } from "./apply-edits";

export interface PatchLimits {
  /** Largest file the agent may edit or write, in bytes. */
  maxFileBytes: number;
  /** Added plus deleted lines across the whole diff. */
  maxChangedLines: number;
  /** Size of the stored unified diff, in bytes. */
  maxDiffBytes: number;
}

export const DEFAULT_PATCH_LIMITS: PatchLimits = {
  maxFileBytes: 256 * 1024,
  maxChangedLines: 1_500,
  maxDiffBytes: 1024 * 1024,
};

/** A validated change to one file. `content` is the full new text, or null for a deletion. */
export interface FileChange {
  path: string;
  change: PlanFileChange;
  content: string | null;
}

export type PatchReview =
  | { ok: true; changes: FileChange[]; unchangedPlanFiles: string[] }
  | { ok: false; problems: string[] };

/**
 * Checks a proposed patch against the approved plan and turns it into full
 * file contents. The plan is the contract: a patch may only touch files the
 * plan lists, with the change kind the plan states. `originals` holds the
 * current text of every planned file that exists.
 */
export function reviewPatch(
  proposal: PatchProposal,
  plan: ImplementationPlan,
  originals: ReadonlyMap<string, string>,
  limits: PatchLimits = DEFAULT_PATCH_LIMITS,
): PatchReview {
  const planned = new Map(plan.affectedFiles.map((f) => [f.path, f.change]));
  const problems: string[] = [];
  const changes: FileChange[] = [];
  const seen = new Set<string>();

  for (const file of proposal.files) {
    let path: string;
    try {
      path = normalizeRelativePath(file.path);
    } catch (err) {
      if (!(err instanceof PathPolicyError)) throw err;
      problems.push(`${JSON.stringify(file.path)} is not a path the agent may change (${err.violation.replace(/_/g, " ")}).`);
      continue;
    }
    if (seen.has(path)) {
      problems.push(`${path} appears more than once; put all edits for a file in one entry.`);
      continue;
    }
    seen.add(path);

    const plannedChange = planned.get(path);
    if (!plannedChange) {
      problems.push(`${path} is not in the approved plan; only change the files the plan lists.`);
      continue;
    }
    if (plannedChange !== file.change) {
      problems.push(`${path} must be a "${plannedChange}" change, as the approved plan states, not "${file.change}".`);
      continue;
    }

    if (file.change === "delete") {
      changes.push({ path, change: "delete", content: null });
      continue;
    }

    let content: string;
    if (file.change === "create") {
      content = file.content;
    } else {
      const original = originals.get(path);
      if (original === undefined) throw new Error(`No current contents were loaded for planned file ${path}`);
      const edited = applyEdits(path, original, file.edits);
      if (!edited.ok) {
        problems.push(...edited.problems);
        continue;
      }
      content = edited.content;
    }

    if (content.includes("\0")) {
      problems.push(`${path}: binary content is not allowed; write text only.`);
    } else if (Buffer.byteLength(content, "utf8") > limits.maxFileBytes) {
      problems.push(`${path}: the new contents exceed ${limits.maxFileBytes.toLocaleString("en-US")} bytes; make a smaller change.`);
    } else {
      changes.push({ path, change: file.change, content });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, changes, unchangedPlanFiles: [...planned.keys()].filter((p) => !seen.has(p)) };
}

/** Checks the committed diff against the size limits. Problems are phrased for the model. */
export function checkDiffLimits(stats: readonly PatchFileStat[], diffBytes: number, limits: PatchLimits = DEFAULT_PATCH_LIMITS): string[] {
  const changed = stats.reduce((n, s) => n + s.additions + s.deletions, 0);
  const problems: string[] = [];
  if (changed > limits.maxChangedLines) {
    problems.push(`The patch changes ${changed} lines, more than the ${limits.maxChangedLines} allowed; implement the plan with a smaller change.`);
  }
  if (diffBytes > limits.maxDiffBytes) {
    problems.push(`The diff is ${Math.round(diffBytes / 1024)} KB, more than the ${Math.round(limits.maxDiffBytes / 1024)} KB allowed.`);
  }
  return problems;
}
