import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { API_CONFIG, ApiConfig } from "./config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ApiConfig>(API_CONFIG);

  app.enableCors({ origin: config.WEB_ORIGIN, credentials: true });
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();

  await app.listen(config.API_PORT);
  Logger.log(`API listening on http://localhost:${config.API_PORT}/api`, "Bootstrap");
}

void bootstrap();
