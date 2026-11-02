import type { CheckResultSummary, ImplementationPlan, PatchFileStat } from "@codepilot/contracts";
import { codeSpan, neutralizeLine, neutralizeMarkdown } from "./markdown";

export interface PullRequestInput {
  taskId: string;
  issue: { number: number; title: string } | null;
  description: string | null;
  plan: ImplementationPlan;
  planVersion: number;
  /** GitHub login of the person who approved the plan; null when it was auto-approved. */
  planApprovedBy: string | null;
  patch: {
    version: number;
    summary: string;
    commitMessage: string;
    model: string;
    baseSha: string;
    files: PatchFileStat[];
    unchangedPlanFiles: string[];
  };
  /** Earlier patch versions for this plan that failed their checks. */
  repairs: number;
  baseBranch: string;
  checks: { runnerImage: string; results: Array<Pick<CheckResultSummary, "profileId" | "kind" | "command" | "status" | "durationMs">> };
}

/** GitHub rejects bodies over 65,536 characters; stay well under. */
const MAX_BODY = 60_000;

const RESULT_LABEL: Record<string, string> = {
  PASSED: "✅ passed",
  FAILED: "❌ failed",
  ERRORED: "⚠️ errored",
  TIMED_OUT: "⏱️ timed out",
};

/**
 * The draft PR a reviewer sees. Everything the model or an issue author wrote
 * is neutralized; check results come from the stored verification only, so
 * the body never claims a check that did not run.
 */
export function buildPullRequest(input: PullRequestInput): { title: string; body: string } {
  const { patch, plan } = input;
  const reasons = new Map(plan.affectedFiles.map((f) => [f.path, f.reason]));
  const sections: string[] = [];

  sections.push(
    `> [!NOTE]\n> Opened by CodePilot AI as a draft. The change was written by an AI model (${codeSpan(patch.model)}) from a plan ${
      input.planApprovedBy ? `approved by ${neutralizeLine(input.planApprovedBy, 39).replace("@", "")}` : "that was auto-approved"
    }, and verified only by the checks listed below. Review it like any other contribution.`,
  );

  const problem = input.issue
    ? `Resolves #${input.issue.number}: ${neutralizeLine(input.issue.title, 200)}`
    : quote(neutralizeMarkdown((input.description ?? "").slice(0, 1_500)));
  sections.push(`## Problem\n\n${problem}`);
  sections.push(`## Summary\n\n${neutralizeMarkdown(patch.summary)}`);

  const rows = patch.files.map(
    (f) => `| ${codeSpan(f.path)} | ${f.change} | +${f.additions} −${f.deletions} | ${neutralizeLine(reasons.get(f.path) ?? "", 200)} |`,
  );
  sections.push(`## Files changed\n\n| File | Change | Lines | Why (from the plan) |\n| --- | --- | --- | --- |\n${rows.join("\n")}`);

  const checkRows = input.checks.results.map(
    (r) => `| ${neutralizeLine(r.profileId, 60)} (${r.kind}) | ${codeSpan(r.command)} | ${RESULT_LABEL[r.status] ?? r.status} | ${(r.durationMs / 1000).toFixed(1)}s |`,
  );
  sections.push(
    [
      "## Checks",
      `Run on this patch (version ${patch.version}) in an isolated container (${codeSpan(input.checks.runnerImage)}, no network during checks) on top of ${codeSpan(patch.baseSha.slice(0, 12))}. These are the only checks that ran.`,
      `| Check | Command | Result | Time |\n| --- | --- | --- | --- |\n${checkRows.join("\n")}`,
    ].join("\n\n"),
  );

  const limitations = [
    ...plan.assumptions.map((a) => `Assumption: ${neutralizeLine(a, 500)}`),
    ...plan.risks.map((r) => `Risk: ${neutralizeLine(r, 500)}`),
    ...(patch.unchangedPlanFiles.length > 0 ? [`Planned but left unchanged: ${patch.unchangedPlanFiles.map(codeSpan).join(", ")}`] : []),
    ...(input.repairs > 0 ? [`${input.repairs} earlier version(s) of this patch failed checks and were repaired.`] : []),
    "Passing checks are evidence, not proof: behaviour the checks do not cover is unverified.",
  ];
  sections.push(`## Limitations and assumptions\n\n${limitations.map((l) => `- ${l}`).join("\n")}`);

  sections.push(
    [
      "<details><summary>Provenance</summary>",
      "",
      `- Task: ${codeSpan(input.taskId)}`,
      `- Base: ${codeSpan(input.baseBranch)} at ${codeSpan(patch.baseSha)}`,
      `- Plan version ${input.planVersion}, patch version ${patch.version}`,
      "",
      "</details>",
    ].join("\n"),
  );

  let body = sections.join("\n\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n…truncated`;
  return { title: neutralizeTitle(patch.commitMessage), body };
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

/** Titles do not render Markdown, but a line break or control character has no place there. */
function neutralizeTitle(subject: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return subject.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) || "CodePilot change";
}
