import type { PatchOutcome } from "@codepilot/contracts";
import { PatchOutcomeSchema } from "@codepilot/contracts";

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;

/**
 * JSON schema for the patch answer (structured outputs). As with planning, it
 * is a flat object with nullable branches, and each file entry carries both
 * `edits` and `content`; toPatchOutcome keeps only the field its change kind
 * uses and the Zod schema enforces every limit.
 */
export const PATCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "patch", "reason"],
  properties: {
    kind: { type: "string", enum: ["patch", "rejected"] },
    reason: { ...nullableString, description: 'Why the plan cannot be implemented. Null when kind is "patch".' },
    patch: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["summary", "commitMessage", "files"],
          properties: {
            summary: { type: "string", description: "What the change does and why, for the reviewer." },
            commitMessage: { type: "string", description: "One imperative subject line, at most 72 characters." },
            files: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "change", "edits", "content"],
                properties: {
                  path: { type: "string" },
                  change: { type: "string", enum: ["modify", "create", "delete"] },
                  edits: {
                    anyOf: [
                      {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: false,
                          required: ["find", "replace"],
                          properties: { find: { type: "string" }, replace: { type: "string" } },
                        },
                      },
                      { type: "null" },
                    ],
                    description: 'For "modify": edits applied in order. Null otherwise.',
                  },
                  content: { ...nullableString, description: 'For "create": the complete file. Null otherwise.' },
                },
              },
            },
          },
        },
        { type: "null" },
      ],
      description: 'The change set. Null when kind is "rejected".',
    },
  },
} as const;

export type ParsedPatchOutcome = { ok: true; outcome: PatchOutcome } | { ok: false; problems: string[] };

/** Validates raw model output. Problems are phrased so they can be fed back to the model. */
export function toPatchOutcome(raw: unknown): ParsedPatchOutcome {
  if (typeof raw !== "object" || raw === null) return { ok: false, problems: ["The answer was not a JSON object."] };
  const { kind, patch, reason } = raw as Record<string, unknown>;

  let candidate: unknown = { kind };
  if (kind === "rejected") candidate = { kind, reason };
  if (kind === "patch") {
    const p = patch as Record<string, unknown> | null;
    const files = Array.isArray(p?.files) ? p.files.map(pickFields) : p?.files;
    candidate = { kind, patch: p && { ...p, files } };
  }

  const parsed = PatchOutcomeSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, outcome: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`),
  };
}

/** Drops the null field the flat schema forces on every file entry. */
function pickFields(file: unknown): unknown {
  if (typeof file !== "object" || file === null) return file;
  const { path, change, edits, content } = file as Record<string, unknown>;
  if (change === "modify") return { path, change, edits };
  if (change === "create") return { path, change, content };
  return { path, change };
}
