import { parseUnifiedDiff } from "@/lib/diff";

/** Lines rendered across all files before the rest is cut off, to keep huge diffs from freezing the page. */
const MAX_LINES = 4_000;
/** Files larger than this start collapsed. */
const COLLAPSE_AFTER = 400;

const CHANGE_LABELS = { create: "added", modify: "modified", delete: "deleted" } as const;

/** A unified diff, one collapsible table per file. Model-written code is rendered as text only, never as HTML. */
export function DiffView({ diff }: { diff: string }) {
  const files = parseUnifiedDiff(diff);
  if (files.length === 0) return <p className="muted small">The diff is empty.</p>;

  let budget = MAX_LINES;
  let hidden = 0;
  return (
    <div className="diff-files">
      {files.map((file) => {
        const lineCount = file.hunks.reduce((n, h) => n + h.lines.length + 1, 0);
        const shown = budget > 0;
        if (!shown) hidden += lineCount;
        budget -= lineCount;
        return (
          <details key={file.path} className="diff-file-box" open={shown && lineCount <= COLLAPSE_AFTER}>
            <summary>
              <code>{file.path}</code>
              <span className="tag">{CHANGE_LABELS[file.change]}</span>
              <span className="ok">+{file.additions}</span>
              <span className="bad">−{file.deletions}</span>
            </summary>
            {!shown ? (
              <p className="muted small">Not shown: the diff is too large to display in full.</p>
            ) : file.binary ? (
              <p className="muted small">Binary file.</p>
            ) : (
              <div className="diff-scroll">
                <table className="diff-table">
                  <tbody>
                    {file.hunks.map((hunk, h) => [
                      <tr key={`h${h}`} className="hunk">
                        <td className="ln" />
                        <td className="ln" />
                        <td className="code">{hunk.header}</td>
                      </tr>,
                      ...hunk.lines.map((line, i) => (
                        <tr key={`${h}-${i}`} className={line.kind}>
                          <td className="ln">{line.oldLine ?? ""}</td>
                          <td className="ln">{line.newLine ?? ""}</td>
                          <td className="code">
                            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                            {line.text}
                          </td>
                        </tr>
                      )),
                    ])}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        );
      })}
      {hidden > 0 && <p className="muted small">{hidden.toLocaleString()} more lines are not shown.</p>}
    </div>
  );
}
