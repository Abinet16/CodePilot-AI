import { extractSymbols } from "./symbols";

const source = `import { x } from "y";

export async function loadUser(id: string) {
  return x(id);
}

export default class UserService extends Base {
  private readonly cache = new Map();

  async findById(id: string): Promise<User | null> {
    if (this.cache.has(id)) {
      return null;
    }
    for (const a of []) {
    }
  }

  get size(): number {
    return 1;
  }
}

export interface User {
  id: string;
}
export type UserId = string;
type Pair<A, B> = [A, B];
export const enum Role { Admin }
export const DEFAULT_LIMIT = 10;
const handler = async () => {};
// export function commented() {}
function* walk() {}
`;

describe("extractSymbols", () => {
  it("finds top-level declarations and methods with their lines", () => {
    const symbols = extractSymbols(source, "typescript");
    expect(symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ["loadUser", "function", true],
      ["UserService", "class", true],
      ["findById", "method", false],
      ["size", "method", false],
      ["User", "interface", true],
      ["UserId", "type", true],
      ["Pair", "type", false],
      ["Role", "enum", true],
      ["DEFAULT_LIMIT", "variable", true],
      ["handler", "variable", false],
      ["walk", "function", false],
    ]);
    expect(symbols.find((s) => s.name === "loadUser")!.line).toBe(3);
    expect(symbols.find((s) => s.name === "findById")!.line).toBe(10);
  });

  it("does not report control flow as methods", () => {
    const names = extractSymbols(source, "typescript").map((s) => s.name);
    expect(names).not.toContain("if");
    expect(names).not.toContain("for");
  });

  it("ignores languages it does not understand", () => {
    expect(extractSymbols("def hello():\n  pass", "python")).toEqual([]);
  });
});
