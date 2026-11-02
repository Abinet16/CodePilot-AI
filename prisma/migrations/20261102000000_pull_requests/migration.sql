-- Week 7: pull requests opened by the agent, linked to the patch they carry, with
-- the state webhooks and reconciliation keep in step with GitHub. Nothing wrote to
-- "pull_requests" before this migration, so the NOT NULL columns need no backfill.

-- AlterTable
ALTER TABLE "pull_requests" ADD COLUMN     "base_branch" TEXT NOT NULL,
ADD COLUMN     "branch_name" TEXT NOT NULL,
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "github_updated_at" TIMESTAMP(3),
ADD COLUMN     "last_synced_at" TIMESTAMP(3),
ADD COLUMN     "merged_at" TIMESTAMP(3),
ADD COLUMN     "patch_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_task_id_key" ON "pull_requests"("task_id");

-- CreateIndex
CREATE INDEX "pull_requests_status_idx" ON "pull_requests"("status");

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_patch_id_fkey" FOREIGN KEY ("patch_id") REFERENCES "patches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

