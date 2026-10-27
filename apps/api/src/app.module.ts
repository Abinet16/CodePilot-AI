import { Global, Module } from "@nestjs/common";
import { API_CONFIG, loadConfig } from "./config";
import { HealthController } from "./health/health.controller";
import { PrismaService } from "./prisma/prisma.service";
import { redisProvider } from "./redis/redis.provider";

@Global()
@Module({
  controllers: [HealthController],
  providers: [{ provide: API_CONFIG, useFactory: () => loadConfig() }, PrismaService, redisProvider],
  exports: [API_CONFIG, PrismaService, redisProvider],
})
export class AppModule {}
