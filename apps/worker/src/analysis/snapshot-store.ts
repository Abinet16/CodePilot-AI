import { randomUUID } from "node:crypto";
import type { IndexStats, ProjectProfile } from "@codepilot/contracts";
import { IndexStatsSchema, ProjectProfileSchema } from "@codepilot/contracts";
import { chunkLines, extractSymbols, searchTextFor } from "@codepilot/agent-core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { ScanResult } from "./scan";

export interface Snapshot {
  id: string;
  commitSha: string;
  profile: ProjectProfile;
  stats: IndexStats;
  paths: string[];
}

const BATCH = 1_000;

async function insertInBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await insert(rows.slice(i, i + BATCH));
}

/**
 * Persists the index of one commit. The snapshot row and all of its files,
 * chunks, and symbols are written in one transaction, so readers never see a
 * half-indexed commit, and two workers indexing the same commit cannot both win.
 */
export class SnapshotStore {
  constructor(private readonly prisma: PrismaClient) {}

  async find(repositoryId: string, commitSha: string): Promise<Snapshot | null> {
    const row = await this.prisma.repositorySnapshot.findUnique({ where: { repositoryId_commitSha: { repositoryId, commitSha } } });
    if (!row) return null;
    return {
      id: row.id,
      commitSha: row.commitSha,
      profile: ProjectProfileSchema.parse(row.profile),
      stats: IndexStatsSchema.parse(row.stats),
      paths: row.paths,
    };
  }

  async save(repositoryId: string, commitSha: string, scan: ScanResult, profile: ProjectProfile): Promise<Snapshot> {
    const snapshotId = randomUUID();
    const files: Prisma.RepositoryFileCreateManyInput[] = [];
    const chunks: Prisma.CodeChunkCreateManyInput[] = [];
    const symbols: Prisma.CodeSymbolCreateManyInput[] = [];

    for (const file of scan.files) {
      const fileId = randomUUID();
      files.push({ id: fileId, snapshotId, path: file.path, contentHash: file.contentHash, language: file.language, sizeBytes: file.sizeBytes });
      for (const chunk of chunkLines(file.content)) {
        chunks.push({
          repositoryFileId: fileId,
          chunkIndex: chunk.index,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          searchText: searchTextFor(chunk.content, file.path),
        });
      }
      for (const symbol of extractSymbols(file.content, file.language)) {
        symbols.push({
          snapshotId,
          repositoryFileId: fileId,
          name: symbol.name,
          nameLower: symbol.name.toLowerCase(),
          kind: symbol.kind,
          line: symbol.line,
          exported: symbol.exported,
        });
      }
    }

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.repositorySnapshot.create({
            data: {
              id: snapshotId,
              repositoryId,
              commitSha,
              profile: profile as Prisma.InputJsonObject,
              stats: scan.stats as Prisma.InputJsonObject,
              paths: scan.paths,
            },
          });
          await insertInBatches(files, (data) => tx.repositoryFile.createMany({ data }));
          await insertInBatches(chunks, (data) => tx.codeChunk.createMany({ data }));
          await insertInBatches(symbols, (data) => tx.codeSymbol.createMany({ data }));
        },
        { maxWait: 10_000, timeout: 120_000 },
      );
    } catch (err) {
      // Another worker committed the same commit first; its snapshot is equivalent.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await this.find(repositoryId, commitSha);
        if (existing) return existing;
      }
      throw err;
    }

    return { id: snapshotId, commitSha, profile, stats: scan.stats, paths: scan.paths };
  }

  /** Keeps the newest `keep` snapshots of a repository and deletes the rest (cascading to files, chunks, symbols). */
  async prune(repositoryId: string, keep: number): Promise<number> {
    const stale = await this.prisma.repositorySnapshot.findMany({
      where: { repositoryId },
      orderBy: { indexedAt: "desc" },
      skip: keep,
      select: { id: true },
    });
    if (stale.length === 0) return 0;
    const { count } = await this.prisma.repositorySnapshot.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    return count;
  }
}
