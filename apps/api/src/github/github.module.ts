import { Module } from "@nestjs/common";
import { API_CONFIG, ApiConfig, githubSettings } from "../config";
import { GITHUB_API, GitHubHttpClient, UnconfiguredGitHubApi } from "./github.client";
import { GithubController } from "./github.controller";
import { InstallationSyncService } from "./installation-sync.service";
import { WebhookService } from "./webhook.service";
import { WebhooksController } from "./webhooks.controller";

@Module({
  controllers: [GithubController, WebhooksController],
  providers: [
    {
      provide: GITHUB_API,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => {
        const settings = githubSettings(config);
        return settings ? new GitHubHttpClient(settings) : new UnconfiguredGitHubApi();
      },
    },
    InstallationSyncService,
    WebhookService,
  ],
  exports: [GITHUB_API, InstallationSyncService],
})
export class GithubModule {}
