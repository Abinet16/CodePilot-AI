import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import type { Request } from "express";
import { SESSION_COOKIE, parseCookies } from "../common/cookies";
import { SessionService } from "./session.service";

export interface AuthUser {
  id: string;
  githubLogin: string;
}

export interface AuthedRequest extends Request {
  authUser?: AuthUser;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? await this.sessions.resolve(token) : null;
    if (!session) throw new UnauthorizedException();
    req.authUser = { id: session.user.id, githubLogin: session.user.githubLogin };
    return true;
  }
}

/** The authenticated user. Only valid on routes protected by SessionGuard. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const user = context.switchToHttp().getRequest<AuthedRequest>().authUser;
  if (!user) throw new UnauthorizedException();
  return user;
});
