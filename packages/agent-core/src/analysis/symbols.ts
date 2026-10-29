/**
 * Line-based declaration finder for TypeScript and JavaScript. It does not
 * build an AST: it is fast, never executes or evaluates repository code, and
 * is good enough to point retrieval at the right lines. False positives only
 * cost a little ranking precision.
 */

export type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "variable" | "method";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the declaration. */
  line: number;
  exported: boolean;
}

const MAX_SYMBOLS_PER_FILE = 500;
const IDENT = "([A-Za-z_$][\\w$]*)";

const DECLARATIONS: Array<{ kind: SymbolKind; re: RegExp }> = [
  { kind: "function", re: new RegExp(`^(export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${IDENT}`) },
  { kind: "class", re: new RegExp(`^(export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${IDENT}`) },
  { kind: "interface", re: new RegExp(`^(export\\s+)?(?:declare\\s+)?interface\\s+${IDENT}`) },
  { kind: "type", re: new RegExp(`^(export\\s+)?(?:declare\\s+)?type\\s+${IDENT}\\s*(?:<[^=]*>)?\\s*=`) },
  { kind: "enum", re: new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+${IDENT}`) },
  { kind: "variable", re: new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${IDENT}`) },
];

const METHOD = new RegExp(
  `^\\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\\s+)*\\*?${IDENT}\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?::\\s*[^={;]+)?\\{\\s*$`,
);

const NOT_METHODS: ReadonlySet<string> = new Set(["if", "for", "while", "switch", "catch", "return", "function", "with", "else", "do", "try"]);

export function extractSymbols(content: string, language: string): CodeSymbol[] {
  if (language !== "typescript" && language !== "javascript") return [];

  const symbols: CodeSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    if (line === trimmed) {
      for (const { kind, re } of DECLARATIONS) {
        const match = re.exec(line);
        if (match) {
          symbols.push({ name: match[2]!, kind, line: i + 1, exported: Boolean(match[1]) || /^export\s+default\b/.test(line) });
          break;
        }
      }
      continue;
    }

    const method = METHOD.exec(line);
    if (method && !NOT_METHODS.has(method[1]!)) {
      symbols.push({ name: method[1]!, kind: "method", line: i + 1, exported: false });
    }
  }
  return symbols;
}
