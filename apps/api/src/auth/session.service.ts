import { Inject, Injectable } from "@nestjs/common";
import type { User } from "@prisma/client";
import { randomToken, sha256Hex } from "../common/crypto";
import { API_CONFIG, ApiConfig } from "../config";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Opaque, revocable sessions. The browser holds a random token; the database
 * holds only its SHA-256, so a database leak does not yield usable sessions.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3_600_000);
    await this.prisma.session.create({ data: { userId, tokenHash: sha256Hex(token), expiresAt } });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<{ sessionId: string; user: User } | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
    return { sessionId: session.id, user: session.user };
  }

  async revoke(token: string): Promise<string | null> {
    const session = await this.prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!session || session.revokedAt) return null;
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return session.userId;
  }
}
