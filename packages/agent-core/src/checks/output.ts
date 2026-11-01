import { maskSecrets } from "../secrets";

export interface OutputSummary {
  text: string;
  truncated: boolean;
}

// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex -- keeps newlines and tabs, drops other control characters
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Makes command output safe to store, show, and give to the model: strips
 * terminal escapes and control characters, masks token-shaped secrets, and
 * bounds the size. Test failures usually show at the end, so the tail gets
 * most of the budget.
 */
export function summarizeOutput(raw: string, maxChars: number): OutputSummary {
  const clean = maskSecrets(raw.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(CONTROL, ""));
  if (clean.length <= maxChars) return { text: clean, truncated: false };

  const marker = `\n… ${(clean.length - maxChars).toLocaleString("en-US")} characters omitted …\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.floor(budget / 4);
  return { text: clean.slice(0, head) + marker + clean.slice(clean.length - (budget - head)), truncated: true };
}
