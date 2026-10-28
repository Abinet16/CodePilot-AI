import { Module } from "@nestjs/common";
import { GithubModule } from "../github/github.module";
import { AuthController } from "./auth.controller";

@Module({
  imports: [GithubModule],
  controllers: [AuthController],
})
export class AuthModule {}
