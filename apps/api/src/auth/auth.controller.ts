import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { CurrentUser as CurrentUserDto } from "@codepilot/contracts";
import type { CookieOptions, Request, Response } from "express";
import { AuditService } from "../audit/audit.service";
import { OAUTH_STATE_COOKIE, SESSION_COOKIE, parseCookies } from "../common/cookies";
import { randomToken, safeEqual } from "../common/crypto";
import { API_CONFIG, ApiConfig, githubSettings } from "../config";
import { GITHUB_API, GitHubApi, GitHubApiError } from "../github/github.client";
import { InstallationSyncService } from "../github/installation-sync.service";
import { PrismaService } from "../prisma/prisma.service";
import { decodeOAuthState, encodeOAuthState, sanitizeReturnTo } from "./oauth-state";
import { AuthUser, CurrentUser, SessionGuard } from "./session.guard";
import { SessionService } from "./session.service";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(GITHUB_API) private readonly github: GitHubApi,
    private readonly sessions: SessionService,
    private readonly sync: InstallationSyncService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  /** The callback is served through the web origin's /api proxy so cookies are first-party. */
  private get redirectUri(): string {
    return `${this.config.WEB_ORIGIN}/api/auth/github/callback`;
  }

  private cookieOptions(overrides: CookieOptions = {}): CookieOptions {
    return {
      httpOnly: true,
      // Lax: sent on GitHub's top-level redirect back to us, withheld from cross-site POST/PATCH.
      sameSite: "lax",
      secure: this.config.WEB_ORIGIN.startsWith("https://"),
      path: "/",
      ...overrides,
    };
  }

  @Get("github/login")
  login(@Query("returnTo") returnTo: unknown, @Res() res: Response): void {
    const settings = githubSettings(this.config);
    if (!settings) throw new ServiceUnavailableException("GitHub App is not configured on this server");

    const state = randomToken(16);
    res.cookie(
      OAUTH_STATE_COOKIE,
      encodeOAuthState({ state, returnTo: sanitizeReturnTo(returnTo) }),
      this.cookieOptions({ maxAge: 10 * 60_000, path: "/api/auth" }),
    );
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", settings.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("state", state);
    res.redirect(302, url.toString());
  }

  @Get("github/callback")
  async callback(
    @Query("code") code: unknown,
    @Query("state") state: unknown,
    @Query("error") error: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const stored = decodeOAuthState(parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE]);
    res.clearCookie(OAUTH_STATE_COOKIE, this.cookieOptions({ path: "/api/auth" }));

    if (typeof error === "string") {
      res.redirect(302, `${this.config.WEB_ORIGIN}/?login=denied`);
      return;
    }
    if (!stored || typeof state !== "string" || !safeEqual(stored.state, state)) {
      throw new BadRequestException("Invalid OAuth state");
    }
    if (typeof code !== "string" || code.length === 0 || code.length > 256) {
      throw new BadRequestException("Missing OAuth code");
    }

    try {
      // The user token lives only in this scope: it is used to identify the
      // user and sync their access, then discarded. It is never persisted.
      const userToken = await this.github.exchangeOAuthCode(code, this.redirectUri);
      const ghUser = await this.github.getAuthenticatedUser(userToken);
      const profile = {
        githubLogin: ghUser.login,
        name: ghUser.name,
        email: ghUser.email,
        avatarUrl: ghUser.avatar_url,
      };
      const user = await this.prisma.user.upsert({
        where: { githubId: BigInt(ghUser.id) },
        create: { githubId: BigInt(ghUser.id), ...profile },
        update: profile,
      });
      await this.sync.syncForUser(user.id, userToken);

      const session = await this.sessions.create(user.id);
      await this.audit.record({
        userId: user.id,
        action: "auth.login",
        metadata: { githubLogin: user.githubLogin, ip: req.ip, userAgent: req.headers["user-agent"] },
      });
      res.cookie(SESSION_COOKIE, session.token, this.cookieOptions({ expires: session.expiresAt }));
      res.redirect(302, `${this.config.WEB_ORIGIN}${stored.returnTo}`);
    } catch (err) {
      if (err instanceof GitHubApiError) throw new BadGatewayException("GitHub request failed");
      throw err;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const userId = token ? await this.sessions.revoke(token) : null;
    if (userId) await this.audit.record({ userId, action: "auth.logout" });
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get("me")
  @UseGuards(SessionGuard)
  async me(@CurrentUser() authUser: AuthUser): Promise<CurrentUserDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: authUser.id } });
    return { id: user.id, githubLogin: user.githubLogin, name: user.name, avatarUrl: user.avatarUrl };
  }
}
