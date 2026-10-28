-- CreateEnum
CREATE TYPE "RepositoryPermission" AS ENUM ('READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN');

-- DropForeignKey
ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_user_id_fkey";

-- DropIndex
DROP INDEX "github_installations_user_id_idx";

-- DropIndex
DROP INDEX "repositories_owner_name_key";

-- AlterTable
ALTER TABLE "github_installations" DROP COLUMN "user_id",
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "issues" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_private" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "removed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatar_url" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_access" (
    "user_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "permission" "RepositoryPermission" NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_access_pkey" PRIMARY KEY ("user_id","repository_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "repository_access_repository_id_idx" ON "repository_access"("repository_id");

-- CreateIndex
CREATE INDEX "repositories_owner_name_idx" ON "repositories"("owner", "name");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_access" ADD CONSTRAINT "repository_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_access" ADD CONSTRAINT "repository_access_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

