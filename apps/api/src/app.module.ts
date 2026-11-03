import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { CoreModule } from "./core.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { GithubModule } from "./github/github.module";
import { HealthController } from "./health/health.controller";
import { RepositoriesModule } from "./repositories/repositories.module";
import { TasksModule } from "./tasks/tasks.module";

@Module({
  imports: [CoreModule, AuthModule, GithubModule, RepositoriesModule, TasksModule, DashboardModule],
  controllers: [HealthController],
})
export class AppModule {}
