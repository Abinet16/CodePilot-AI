import type { ChunkCandidate, RetrievalQuery } from "@codepilot/agent-core";
import { toTsQuery } from "@codepilot/agent-core";
import type { PrismaClient } from "@prisma/client";

interface ChunkRow {
  path: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "CONTRIBUTING.md"];

/** Relative weights of each retrieval signal. An explicit mention beats a name match, which beats text similarity. */
const SCORES = { pathFirstChunk: 10, pathLaterChunk: 7, symbol: 6, exportedSymbolBonus: 1, instructions: 3, textBase: 0.5, textMax: 4 };

/**
 * Finds candidate chunks in one indexed snapshot using four signals: paths
 * named in the task, symbol names, PostgreSQL full-text search, and the
 * repository's own agent instructions. Everything is scoped to the snapshot,
 * so results always refer to the pinned commit.
 */
export class ContextRetriever {
  constructor(private readonly prisma: PrismaClient) {}

  async candidates(snapshotId: string, query: RetrievalQuery): Promise<ChunkCandidate[]> {
    const [byPath, bySymbol, byText, instructions] = await Promise.all([
      this.pathMatches(snapshotId, query.paths),
      this.symbolMatches(snapshotId, query.identifiers),
      this.textMatches(snapshotId, query.terms),
      this.instructionFiles(snapshotId),
    ]);
    return [...byPath, ...bySymbol, ...byText, ...instructions];
  }

  private async pathMatches(snapshotId: string, paths: string[]): Promise<ChunkCandidate[]> {
    if (paths.length === 0) return [];
    const files = await this.prisma.repositoryFile.findMany({
      where: { snapshotId, OR: [{ path: { in: paths } }, ...paths.map((p) => ({ path: { endsWith: `/${p}` } }))] },
      include: { chunks: { where: { chunkIndex: { lt: 2 } }, orderBy: { chunkIndex: "asc" } } },
      orderBy: { path: "asc" },
      take: 10,
    });
    return files.flatMap((file) =>
      file.chunks.map((c) => ({
        path: file.path,
        chunkIndex: c.chunkIndex,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        score: c.chunkIndex === 0 ? SCORES.pathFirstChunk : SCORES.pathLaterChunk,
        reasons: ["path_mentioned" as const],
      })),
    );
  }

  private async symbolMatches(snapshotId: string, identifiers: string[]): Promise<ChunkCandidate[]> {
    const names = [...new Set(identifiers.map((i) => i.toLowerCase()))];
    if (names.length === 0) return [];
    const rows = await this.prisma.$queryRaw<Array<ChunkRow & { exported: boolean }>>`
      SELECT f.path, c.chunk_index AS "chunkIndex", c.start_line AS "startLine", c.end_line AS "endLine", c.content, bool_or(s.exported) AS exported
      FROM code_symbols s
      JOIN repository_files f ON f.id = s.repository_file_id
      JOIN code_chunks c ON c.repository_file_id = f.id AND s.line BETWEEN c.start_line AND c.end_line
      WHERE s.snapshot_id = ${snapshotId}::uuid AND s.name_lower = ANY(${names})
      GROUP BY f.path, c.chunk_index, c.start_line, c.end_line, c.content
      ORDER BY f.path, c.chunk_index
      LIMIT 40`;
    return rows.map(({ exported, ...row }) => ({
      ...row,
      score: SCORES.symbol + (exported ? SCORES.exportedSymbolBonus : 0),
      reasons: ["symbol_match" as const],
    }));
  }

  private async textMatches(snapshotId: string, terms: string[]): Promise<ChunkCandidate[]> {
    const tsquery = toTsQuery(terms);
    if (!tsquery) return [];
    const rows = await this.prisma.$queryRaw<Array<ChunkRow & { rank: number }>>`
      SELECT f.path, c.chunk_index AS "chunkIndex", c.start_line AS "startLine", c.end_line AS "endLine", c.content,
             ts_rank_cd(c.search_vector, q) AS rank
      FROM code_chunks c
      JOIN repository_files f ON f.id = c.repository_file_id
      CROSS JOIN to_tsquery('simple', ${tsquery}) q
      WHERE f.snapshot_id = ${snapshotId}::uuid AND c.search_vector @@ q
      ORDER BY rank DESC, f.path, c.chunk_index
      LIMIT 40`;
    const best = Math.max(...rows.map((r) => r.rank), Number.EPSILON);
    return rows.map(({ rank, ...row }) => ({
      ...row,
      score: SCORES.textBase + (SCORES.textMax * rank) / best,
      reasons: ["text_match" as const],
    }));
  }

  private async instructionFiles(snapshotId: string): Promise<ChunkCandidate[]> {
    const files = await this.prisma.repositoryFile.findMany({
      where: { snapshotId, path: { in: INSTRUCTION_FILES } },
      include: { chunks: { where: { chunkIndex: 0 } } },
    });
    return files.flatMap((file) =>
      file.chunks.map((c) => ({
        path: file.path,
        chunkIndex: c.chunkIndex,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        score: SCORES.instructions,
        reasons: ["instructions" as const],
      })),
    );
  }
}
