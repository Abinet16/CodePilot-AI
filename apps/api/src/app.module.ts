import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { CoreModule } from "./core.module";
import { GithubModule } from "./github/github.module";
import { HealthController } from "./health/health.controller";
import { RepositoriesModule } from "./repositories/repositories.module";

@Module({
  imports: [CoreModule, AuthModule, GithubModule, RepositoriesModule],
  controllers: [HealthController],
})
export class AppModule {}
