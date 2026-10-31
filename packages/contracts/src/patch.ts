import { z } from "zod";
import type { PlanFileChange } from "./plan";

/**
 * The model's proposed change set for an approved plan. Paths and text are
 * untrusted model output: the worker checks every file against the approved
 * plan and the path policy, and applies edits only inside the workspace.
 */
export const FileEditSchema = z.object({
  /** Exact text from the current file. It must occur exactly once. */
  find: z.string().min(1).max(20_000),
  replace: z.string().max(50_000),
});

export type FileEdit = z.infer<typeof FileEditSchema>;

const patchPath = z.string().min(1).max(500);

export const PatchFileSchema = z.discriminatedUnion("change", [
  z.object({ path: patchPath, change: z.literal("modify"), edits: z.array(FileEditSchema).min(1).max(50) }),
  z.object({ path: patchPath, change: z.literal("create"), content: z.string().max(200_000) }),
  z.object({ path: patchPath, change: z.literal("delete") }),
]);

export type PatchFile = z.infer<typeof PatchFileSchema>;

export const PatchProposalSchema = z.object({
  summary: z.string().min(1).max(2_000),
  /** Subject line only; the worker adds the body and trailers. */
  commitMessage: z
    .string()
    .trim()
    .min(1)
    .max(72)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "must be a single line without control characters"),
  files: z.array(PatchFileSchema).min(1).max(25),
});

export type PatchProposal = z.infer<typeof PatchProposalSchema>;

/** Like planning, the model may decline when the approved plan cannot be implemented as written. */
export const PatchOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("patch"), patch: PatchProposalSchema }),
  z.object({ kind: z.literal("rejected"), reason: z.string().min(1).max(2_000) }),
]);

export type PatchOutcome = z.infer<typeof PatchOutcomeSchema>;

/** Mirrors PatchStatus in the Prisma schema. */
export const PATCH_STATUSES = ["PROPOSED", "VERIFIED", "REJECTED", "SUPERSEDED", "SUBMITTED"] as const;
export type PatchStatus = (typeof PATCH_STATUSES)[number];

export interface PatchFileStat {
  path: string;
  change: PlanFileChange;
  additions: number;
  deletions: number;
}

export interface PatchSummary {
  /** Counts every patch attempt on the task; a repair writes the next version. */
  version: number;
  status: PatchStatus;
  /** The approved plan version this patch implements. */
  planVersion: number;
  baseSha: string;
  commitSha: string;
  treeSha: string;
  branchName: string;
  summary: string;
  commitMessage: string;
  model: string;
  files: PatchFileStat[];
  /** Files in the approved plan that the patch left unchanged, so a reviewer can see what was skipped. */
  unchangedPlanFiles: string[];
  additions: number;
  deletions: number;
  createdAt: string;
}

export interface PatchDetail extends PatchSummary {
  /** Unified diff against baseSha, as stored. Render as text only. */
  diff: string;
}
