import type { FileEdit } from "@codepilot/contracts";

export type EditResult = { ok: true; content: string } | { ok: false; problems: string[] };

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (++count > 1) return count;
  }
  return count;
}

/**
 * Applies find/replace edits in order. Each `find` must occur exactly once in
 * the file as it stands after the earlier edits, so an edit can never land
 * somewhere the model did not intend. Problems name the file and edit so they
 * can be fed back to the model.
 */
export function applyEdits(path: string, original: string, edits: readonly FileEdit[]): EditResult {
  let content = original;
  const problems: string[] = [];

  edits.forEach((edit, i) => {
    const n = occurrences(content, edit.find);
    if (n === 1) {
      const at = content.indexOf(edit.find);
      content = content.slice(0, at) + edit.replace + content.slice(at + edit.find.length);
    } else if (n === 0) {
      problems.push(`${path} edit ${i + 1}: the find text does not occur in the file; copy it exactly from the current contents, including whitespace.`);
    } else {
      problems.push(`${path} edit ${i + 1}: the find text occurs more than once; include more surrounding lines so it matches exactly one place.`);
    }
  });

  if (problems.length > 0) return { ok: false, problems };
  if (content === original) return { ok: false, problems: [`${path}: the edits leave the file unchanged.`] };
  return { ok: true, content };
}
