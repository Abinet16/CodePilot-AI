-- Week 5: patches become versioned attempts tied to the approved plan they implement.
-- Nothing wrote to "patches" before this migration, so the new NOT NULL columns
-- need no backfill. The (task_id, diff_hash) unique index is replaced because a
-- repair may reproduce an earlier diff, and every attempt is kept.

-- DropIndex
DROP INDEX "patches_task_id_diff_hash_key";

-- AlterTable
ALTER TABLE "patches" ADD COLUMN     "additions" INTEGER NOT NULL,
ADD COLUMN     "branch_name" TEXT NOT NULL,
ADD COLUMN     "commit_message" TEXT NOT NULL,
ADD COLUMN     "commit_sha" TEXT NOT NULL,
ADD COLUMN     "deletions" INTEGER NOT NULL,
ADD COLUMN     "files" JSONB NOT NULL,
ADD COLUMN     "model" TEXT NOT NULL,
ADD COLUMN     "plan_id" UUID NOT NULL,
ADD COLUMN     "summary" TEXT NOT NULL,
ADD COLUMN     "tree_sha" TEXT NOT NULL,
ADD COLUMN     "unchanged_plan_files" TEXT[],
ADD COLUMN     "version" INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX "patches_task_id_diff_hash_idx" ON "patches"("task_id", "diff_hash");

-- CreateIndex
CREATE UNIQUE INDEX "patches_task_id_version_key" ON "patches"("task_id", "version");

-- AddForeignKey
ALTER TABLE "patches" ADD CONSTRAINT "patches_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "implementation_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

