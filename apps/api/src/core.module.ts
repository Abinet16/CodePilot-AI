import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit/audit.service";
import { SessionGuard } from "./auth/session.guard";
import { SessionService } from "./auth/session.service";
import { API_CONFIG, loadConfig } from "./config";
import { PrismaService } from "./prisma/prisma.service";
import { redisProvider } from "./redis/redis.provider";

/** Infrastructure shared by every feature module. */
@Global()
@Module({
  providers: [
    { provide: API_CONFIG, useFactory: () => loadConfig() },
    PrismaService,
    redisProvider,
    AuditService,
    SessionService,
    SessionGuard,
  ],
  exports: [API_CONFIG, PrismaService, redisProvider, AuditService, SessionService, SessionGuard],
})
export class CoreModule {}
