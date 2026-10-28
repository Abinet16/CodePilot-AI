import { Controller, Get, Inject, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { SessionGuard } from "../auth/session.guard";
import { API_CONFIG, ApiConfig, githubSettings } from "../config";

@Controller("github")
export class GithubController {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  /** Sends a signed-in user to GitHub to install the app on chosen repositories. */
  @Get("install")
  @UseGuards(SessionGuard)
  install(@Res() res: Response): void {
    const settings = githubSettings(this.config);
    if (!settings) throw new ServiceUnavailableException("GitHub App is not configured on this server");
    res.redirect(302, `https://github.com/apps/${encodeURIComponent(settings.slug)}/installations/new`);
  }

  /**
   * GitHub's post-install "Setup URL". The installation_id query parameter is
   * attacker-controllable, so it is ignored: access is re-derived from the
   * user's own GitHub token by running the login flow again.
   */
  @Get("setup")
  setup(@Res() res: Response): void {
    res.redirect(302, "/api/auth/github/login?returnTo=/repositories");
  }
}
