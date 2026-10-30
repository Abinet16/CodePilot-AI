-- Week 4: plan review state, per-stage agent runs, and run-linked usage.
-- agent_runs and implementation_plans had no writers before this migration,
-- so the new NOT NULL columns need no backfill.

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('PROPOSED', 'APPROVED', 'CHANGES_REQUESTED');

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN     "error" TEXT,
ADD COLUMN     "stage" "TaskStatus" NOT NULL;

-- AlterTable
ALTER TABLE "implementation_plans" ADD COLUMN     "feedback" TEXT,
ADD COLUMN     "model" TEXT NOT NULL,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by" UUID,
ADD COLUMN     "run_id" UUID,
ADD COLUMN     "status" "PlanStatus" NOT NULL DEFAULT 'PROPOSED';

-- AlterTable
ALTER TABLE "usage_records" ADD COLUMN     "run_id" UUID;

-- CreateIndex
CREATE INDEX "usage_records_task_id_idx" ON "usage_records"("task_id");

-- AddForeignKey
ALTER TABLE "implementation_plans" ADD CONSTRAINT "implementation_plans_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_plans" ADD CONSTRAINT "implementation_plans_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
