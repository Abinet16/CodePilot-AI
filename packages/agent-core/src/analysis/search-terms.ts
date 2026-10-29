/**
 * Tokenization shared by indexing and querying, so that `getUserById`,
 * `get_user_by_id`, and "get user by id" all meet in the same search terms.
 * Every emitted term matches [a-z0-9]+, which also makes terms safe to join
 * into a PostgreSQL tsquery without escaping.
 */

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Language keywords and English filler that carry no retrieval signal. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "the and for are but not you all any can her was one our out has have from with this that they will would there their what " +
    "when which who how why into than then them these those been being were also just should could about after before over " +
    "only some such its it is in on of to a an as at be by do if or so we me my no up use used using need needs want make " +
    "const let var function return import export default class interface type extends implements new this true false null " +
    "undefined void async await from require module exports public private protected static readonly string number boolean"
  ).split(" "),
);

/** Splits camelCase, PascalCase, snake_case, kebab-case, and acronyms into lowercase parts. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The forms of one identifier that are searchable: its parts plus the joined whole. */
function termsFor(identifier: string): string[] {
  const parts = splitIdentifier(identifier);
  const whole = parts.join("");
  const terms = parts.length > 1 ? [whole, ...parts] : parts;
  return terms.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/** Text stored next to each chunk and turned into a tsvector by PostgreSQL. */
export function searchTextFor(content: string, filePath: string): string {
  const terms: string[] = [];
  for (const part of filePath.split(/[/.]/)) terms.push(...termsFor(part));
  for (const match of content.matchAll(IDENTIFIER)) terms.push(...termsFor(match[0]));
  return terms.join(" ");
}

export interface RetrievalQuery {
  /** Repository paths mentioned in the text, normalized to repository-relative form. */
  paths: string[];
  /** Code identifiers mentioned in the text, original casing. */
  identifiers: string[];
  /** Normalized full-text search terms. */
  terms: string[];
}

const PATH_LIKE = /(?:\.{0,2}\/)?[\w@-]+(?:\/[\w.@-]+)*\.[A-Za-z]{1,6}\b|(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w.@-]+){1,}/g;
const CODE_LIKE = /^(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|\w+_\w+|[A-Z][A-Z0-9_]{2,})$/;
const MAX_TERMS = 40;

/** Extracts search inputs from an issue title and body or a task description. */
export function buildRetrievalQuery(text: string): RetrievalQuery {
  const bounded = text.slice(0, 20_000);

  const paths = new Set<string>();
  // URLs look like paths but never name repository files.
  for (const match of bounded.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").matchAll(PATH_LIKE)) {
    const candidate = match[0].replace(/^\.{0,2}\//, "").replace(/[.,:;]+$/, "");
    if (candidate.includes("/") || /\.[A-Za-z]{1,6}$/.test(candidate)) {
      if (!candidate.startsWith("/") && !candidate.includes("..")) paths.add(candidate);
    }
  }

  const identifiers = new Set<string>();
  for (const match of bounded.matchAll(/`([^`\n]{1,100})`/g)) {
    for (const id of match[1]!.matchAll(IDENTIFIER)) if (id[0].length >= 3) identifiers.add(id[0]);
  }
  for (const match of bounded.matchAll(IDENTIFIER)) {
    if (CODE_LIKE.test(match[0])) identifiers.add(match[0]);
  }

  const terms = new Set<string>();
  for (const id of identifiers) for (const t of termsFor(id)) terms.add(t);
  for (const match of bounded.matchAll(IDENTIFIER)) {
    for (const t of termsFor(match[0])) if (t.length >= 3) terms.add(t);
  }

  return {
    paths: [...paths].slice(0, 20),
    identifiers: [...identifiers].slice(0, 30),
    terms: [...terms].slice(0, MAX_TERMS),
  };
}

/** An OR-query over terms for to_tsquery('simple', ...), or null when there is nothing to search. */
export function toTsQuery(terms: readonly string[]): string | null {
  const safe = terms.filter((t) => /^[a-z0-9]+$/.test(t));
  return safe.length ? safe.join(" | ") : null;
}
