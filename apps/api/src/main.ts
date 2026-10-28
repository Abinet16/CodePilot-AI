import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { API_CONFIG, ApiConfig } from "./config";

export function configureApp(app: NestExpressApplication): void {
  // GitHub webhook payloads can be large; signature checks need the raw bytes (rawBody: true).
  app.useBodyParser("json", { limit: "5mb" });
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get<ApiConfig>(API_CONFIG);

  // The dashboard proxies /api to this server, so browsers talk same-origin.
  // CORS stays narrow for direct calls during development.
  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  configureApp(app);

  await app.listen(config.API_PORT);
  Logger.log(`API listening on http://localhost:${config.API_PORT}/api`, "Bootstrap");
}

if (require.main === module) void bootstrap();
