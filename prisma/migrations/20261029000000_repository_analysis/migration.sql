-- Repository files and chunks are derived data keyed by commit; they are
-- rebuilt on demand, so existing rows (if any) are discarded.
TRUNCATE TABLE "code_chunks", "repository_files";

-- DropForeignKey
ALTER TABLE "repository_files" DROP CONSTRAINT "repository_files_repository_id_fkey";

-- DropIndex
DROP INDEX "repository_files_repository_id_commit_sha_path_key";

-- AlterTable
ALTER TABLE "agent_tasks" ADD COLUMN     "analysis" JSONB;

-- AlterTable
ALTER TABLE "code_chunks" ADD COLUMN     "search_text" TEXT NOT NULL,
ADD COLUMN     "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "search_text")) STORED;

-- AlterTable
ALTER TABLE "repository_files" DROP COLUMN "commit_sha",
DROP COLUMN "indexed_at",
DROP COLUMN "repository_id",
ADD COLUMN     "size_bytes" INTEGER NOT NULL,
ADD COLUMN     "snapshot_id" UUID NOT NULL,
ALTER COLUMN "language" SET NOT NULL;

-- CreateTable
CREATE TABLE "repository_snapshots" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "stats" JSONB NOT NULL,
    "paths" TEXT[],
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_symbols" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "repository_file_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_lower" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "exported" BOOLEAN NOT NULL,

    CONSTRAINT "code_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repository_snapshots_repository_id_indexed_at_idx" ON "repository_snapshots"("repository_id", "indexed_at");

-- CreateIndex
CREATE UNIQUE INDEX "repository_snapshots_repository_id_commit_sha_key" ON "repository_snapshots"("repository_id", "commit_sha");

-- CreateIndex
CREATE INDEX "code_symbols_snapshot_id_name_lower_idx" ON "code_symbols"("snapshot_id", "name_lower");

-- CreateIndex
CREATE INDEX "code_symbols_repository_file_id_idx" ON "code_symbols"("repository_file_id");

-- CreateIndex
CREATE INDEX "code_chunks_search_vector_idx" ON "code_chunks" USING GIN ("search_vector");

-- CreateIndex
CREATE UNIQUE INDEX "repository_files_snapshot_id_path_key" ON "repository_files"("snapshot_id", "path");

-- AddForeignKey
ALTER TABLE "repository_snapshots" ADD CONSTRAINT "repository_snapshots_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_files" ADD CONSTRAINT "repository_files_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "repository_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "repository_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_repository_file_id_fkey" FOREIGN KEY ("repository_file_id") REFERENCES "repository_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

