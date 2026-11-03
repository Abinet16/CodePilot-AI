/**
 * Parses the unified diffs CodePilot stores (`git diff --binary --full-index
 * --no-renames`) into files and hunks with line numbers, for the diff viewer.
 * Input is model-written code: it is only ever rendered as text.
 */

export interface DiffLine {
  kind: "add" | "del" | "context" | "note";
  text: string;
  /** Line number in the old file, for deletions and context. */
  oldLine: number | null;
  /** Line number in the new file, for additions and context. */
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  change: "create" | "modify" | "delete";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      file = { path: header[2]!, change: "modify", binary: false, additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith("new file mode")) file.change = "create";
      else if (line.startsWith("deleted file mode")) file.change = "delete";
      else if (line.startsWith("Binary files") || line === "GIT binary patch") file.binary = true;
      else if (line.startsWith("--- a/") && file.change !== "create") file.path = line.slice(6);
      else if (line.startsWith("+++ b/")) file.path = line.slice(6);
    }

    const range = HUNK_HEADER.exec(line);
    if (range) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldLine = Number(range[1]);
      newLine = Number(range[2]);
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++ });
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldLine: oldLine++, newLine: null });
      file.deletions++;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "note", text: line.slice(2), oldLine: null, newLine: null });
    }
  }
  return files;
}
