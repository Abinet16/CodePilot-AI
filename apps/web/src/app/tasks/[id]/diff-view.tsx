/** Lines shown before the rest of a long diff is cut off. */
const MAX_LINES = 3_000;

function lineClass(line: string): string | undefined {
  if (line.startsWith("diff --git")) return "diff-file";
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return undefined;
}

/** A unified diff. Model-written code is rendered as text only, never as HTML. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  const shown = lines.slice(0, MAX_LINES);
  return (
    <>
      <pre className="diff">
        {shown.map((line, i) => (
          <span key={i} className={lineClass(line)}>
            {line}
          </span>
        ))}
      </pre>
      {lines.length > MAX_LINES && <p className="muted small">{(lines.length - MAX_LINES).toLocaleString()} more lines not shown.</p>}
    </>
  );
}
