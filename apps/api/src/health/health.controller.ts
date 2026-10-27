import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { HealthResponse } from "@codepilot/contracts";
import type { Response } from "express";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { InjectRedis } from "../redis/redis.provider";

@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.probe(() => this.redis.ping()),
    ]);
    const checks = { database, redis };
    const healthy = Object.values(checks).every((c) => c === "ok");
    if (!healthy) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: healthy ? "ok" : "degraded", checks };
  }

  private async probe(fn: () => Promise<unknown>): Promise<"ok" | "error"> {
    try {
      await fn();
      return "ok";
    } catch {
      return "error";
    }
  }
}
