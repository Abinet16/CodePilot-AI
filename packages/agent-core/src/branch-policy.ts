/**
 * Branch names for agent work. The agent only ever commits to a branch it
 * created for one task, under a fixed prefix, never to the default branch or
 * any branch a human works on.
 */
export const TASK_BRANCH_PREFIX = "codepilot/";

const TASK_BRANCH = /^codepilot\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BRANCH_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BranchPolicyError extends Error {
  constructor(readonly branch: string, reason: string) {
    super(`Branch ${JSON.stringify(branch)} is not allowed: ${reason}`);
    this.name = "BranchPolicyError";
  }
}

/**
 * `codepilot/<slug>-<first 8 hex of the task id>`. The slug comes from the
 * task title, which is untrusted, so it is reduced to lowercase ASCII words.
 */
export function taskBranchName(taskId: string, title: string): string {
  if (!UUID.test(taskId)) throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  const name = `${TASK_BRANCH_PREFIX}${slug ? `${slug}-` : ""}${taskId.slice(0, 8)}`;
  assertTaskBranch(name, []);
  return name;
}

/** Throws unless `branch` is an agent task branch and not one of the protected branches. */
export function assertTaskBranch(branch: string, protectedBranches: readonly string[]): void {
  if (branch.length > MAX_BRANCH_LENGTH) throw new BranchPolicyError(branch, `longer than ${MAX_BRANCH_LENGTH} characters`);
  if (!TASK_BRANCH.test(branch)) throw new BranchPolicyError(branch, `agent branches must match ${TASK_BRANCH_PREFIX}<lowercase-words>`);
  if (protectedBranches.includes(branch)) throw new BranchPolicyError(branch, "it is a protected branch");
}
