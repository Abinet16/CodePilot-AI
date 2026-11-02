/**
 * Makes untrusted text (model output, issue text, check names) inert inside a
 * GitHub-rendered Markdown body:
 * - no HTML, comments, or entities pass through (`<`, `>`, `&` are escaped);
 * - no @mentions or team pings (a zero-width joiner breaks the handle);
 * - no images or links, which could track readers or disguise a destination;
 * - no control characters.
 * Plain prose, lists, and code spans still read normally.
 */
export function neutralizeMarkdown(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, "$1@‍")
      .replace(/!\[/g, "!\\[")
      .replace(/\]\(/g, "]\\(")
      .replace(/\]\[/g, "]\\[")
  );
}

/** A single line of untrusted text, bounded, for table cells and titles. */
export function neutralizeLine(text: string, maxLength: number): string {
  const line = neutralizeMarkdown(text.replace(/\s+/g, " ").trim()).replace(/\|/g, "\\|");
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

/** A code span that cannot be closed early by the text inside it. */
export function codeSpan(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}
