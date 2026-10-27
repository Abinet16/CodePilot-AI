-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "InstallationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'ANALYZING', 'PLANNING', 'AWAITING_PLAN_APPROVAL', 'GENERATING_PATCH', 'RUNNING_CHECKS', 'REPAIRING', 'READY_FOR_REVIEW', 'OPENING_PR', 'PR_OPENED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PatchStatus" AS ENUM ('PROPOSED', 'VERIFIED', 'REJECTED', 'SUPERSEDED', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "TestRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ERRORED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "PullRequestStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "github_id" BIGINT NOT NULL,
    "github_login" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "installation_id" BIGINT NOT NULL,
    "account_login" TEXT NOT NULL,
    "status" "InstallationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "github_repo_id" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_settings" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "allowed_commands" JSONB NOT NULL DEFAULT '[]',
    "test_commands" JSONB NOT NULL DEFAULT '[]',
    "policy_config" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "repository_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "github_issue_number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" "IssueState" NOT NULL DEFAULT 'OPEN',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "issue_id" UUID,
    "requested_by" UUID NOT NULL,
    "description" TEXT,
    "require_plan_approval" BOOLEAN NOT NULL DEFAULT true,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "base_sha" TEXT,
    "branch_name" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "token_usage" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "implementation_plans" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "plan_json" JSONB NOT NULL,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "implementation_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_files" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "commit_sha" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "language" TEXT,
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_chunks" (
    "id" UUID NOT NULL,
    "repository_file_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "code_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patches" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "base_sha" TEXT NOT NULL,
    "patch_content" TEXT NOT NULL,
    "diff_hash" TEXT NOT NULL,
    "status" "PatchStatus" NOT NULL DEFAULT 'PROPOSED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_runs" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "patch_id" UUID,
    "runner_image" TEXT NOT NULL,
    "status" "TestRunStatus" NOT NULL DEFAULT 'QUEUED',
    "exit_code" INTEGER,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" UUID NOT NULL,
    "test_run_id" UUID NOT NULL,
    "command" TEXT NOT NULL,
    "exit_code" INTEGER,
    "output_summary" TEXT NOT NULL,
    "log_object_key" TEXT,
    "duration_ms" INTEGER NOT NULL,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "github_pr_number" INTEGER NOT NULL,
    "github_pr_url" TEXT NOT NULL,
    "head_sha" TEXT NOT NULL,
    "status" "PullRequestStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" "TaskStatus",
    "to_status" "TaskStatus",
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "task_id" UUID,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "task_id" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "estimated_cost" DECIMAL(12,6) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'IN_PROGRESS',
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "delivery_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("delivery_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "users"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");

-- CreateIndex
CREATE INDEX "github_installations_user_id_idx" ON "github_installations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_github_repo_id_key" ON "repositories"("github_repo_id");

-- CreateIndex
CREATE INDEX "repositories_installation_id_idx" ON "repositories"("installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_owner_name_key" ON "repositories"("owner", "name");

-- CreateIndex
CREATE UNIQUE INDEX "repository_settings_repository_id_key" ON "repository_settings"("repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "issues_repository_id_github_issue_number_key" ON "issues"("repository_id", "github_issue_number");

-- CreateIndex
CREATE INDEX "agent_tasks_status_idx" ON "agent_tasks"("status");

-- CreateIndex
CREATE INDEX "agent_tasks_requested_by_created_at_idx" ON "agent_tasks"("requested_by", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tasks_repository_id_branch_name_key" ON "agent_tasks"("repository_id", "branch_name");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_task_id_attempt_number_key" ON "agent_runs"("task_id", "attempt_number");

-- CreateIndex
CREATE UNIQUE INDEX "implementation_plans_task_id_version_key" ON "implementation_plans"("task_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "repository_files_repository_id_commit_sha_path_key" ON "repository_files"("repository_id", "commit_sha", "path");

-- CreateIndex
CREATE UNIQUE INDEX "code_chunks_repository_file_id_chunk_index_key" ON "code_chunks"("repository_file_id", "chunk_index");

-- CreateIndex
CREATE UNIQUE INDEX "patches_task_id_diff_hash_key" ON "patches"("task_id", "diff_hash");

-- CreateIndex
CREATE INDEX "test_runs_task_id_idx" ON "test_runs"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_repository_id_github_pr_number_key" ON "pull_requests"("repository_id", "github_pr_number");

-- CreateIndex
CREATE INDEX "task_events_task_id_created_at_idx" ON "task_events"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_task_id_idx" ON "audit_logs"("task_id");

-- CreateIndex
CREATE INDEX "usage_records_user_id_created_at_idx" ON "usage_records"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_settings" ADD CONSTRAINT "repository_settings_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_plans" ADD CONSTRAINT "implementation_plans_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_files" ADD CONSTRAINT "repository_files_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_repository_file_id_fkey" FOREIGN KEY ("repository_file_id") REFERENCES "repository_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patches" ADD CONSTRAINT "patches_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patches" ADD CONSTRAINT "patches_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_patch_id_fkey" FOREIGN KEY ("patch_id") REFERENCES "patches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_run_id_fkey" FOREIGN KEY ("test_run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

