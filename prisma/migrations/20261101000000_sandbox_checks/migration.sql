-- Week 6: check configuration per repository, and per-check results for each patch
-- verification. allowed_commands and test_commands had no writers or readers, so
-- they are replaced by install_command and checks without a data migration.
-- test_results had no writers either, so its new NOT NULL columns need no backfill.

-- AlterTable
ALTER TABLE "repository_settings" DROP COLUMN "allowed_commands",
DROP COLUMN "test_commands",
ADD COLUMN     "checks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "install_command" JSONB,
ADD COLUMN     "updated_at" TIMESTAMP(3),
ADD COLUMN     "updated_by" UUID;

-- AlterTable
ALTER TABLE "test_results" ADD COLUMN     "kind" TEXT NOT NULL,
ADD COLUMN     "output_truncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "position" INTEGER NOT NULL,
ADD COLUMN     "profile_id" TEXT NOT NULL,
ADD COLUMN     "status" "TestRunStatus" NOT NULL;

-- AlterTable
ALTER TABLE "test_runs" ADD COLUMN     "error" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "test_results_test_run_id_position_key" ON "test_results"("test_run_id", "position");

-- CreateIndex
CREATE INDEX "test_runs_patch_id_idx" ON "test_runs"("patch_id");

-- AddForeignKey
ALTER TABLE "repository_settings" ADD CONSTRAINT "repository_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

