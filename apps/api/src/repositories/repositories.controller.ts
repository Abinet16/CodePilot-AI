import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Put, UseGuards } from "@nestjs/common";
import {
  IssueSummary,
  RepositoryChecks,
  RepositoryChecksResponse,
  RepositoryChecksSchema,
  RepositoryDetail,
  RepositorySummary,
  UpdateRepositoryRequest,
  UpdateRepositoryRequestSchema,
} from "@codepilot/contracts";
import { AuthUser, CurrentUser, SessionGuard } from "../auth/session.guard";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { RepositoriesService } from "./repositories.service";

@Controller("repositories")
@UseGuards(SessionGuard)
export class RepositoriesController {
  constructor(private readonly repositories: RepositoriesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<RepositorySummary[]> {
    return this.repositories.listForUser(user.id);
  }

  @Get(":id")
  detail(@CurrentUser() user: AuthUser, @Param("id", new ParseUUIDPipe()) id: string): Promise<RepositoryDetail> {
    return this.repositories.getDetail(user.id, id);
  }

  @Get(":id/issues")
  issues(@CurrentUser() user: AuthUser, @Param("id", new ParseUUIDPipe()) id: string): Promise<IssueSummary[]> {
    return this.repositories.listOpenIssues(user.id, id);
  }

  @Get(":id/checks")
  checks(@CurrentUser() user: AuthUser, @Param("id", new ParseUUIDPipe()) id: string): Promise<RepositoryChecksResponse> {
    return this.repositories.getChecks(user.id, id);
  }

  @Put(":id/checks")
  setChecks(
    @CurrentUser() user: AuthUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodBodyPipe(RepositoryChecksSchema)) body: RepositoryChecks,
  ): Promise<RepositoryChecksResponse> {
    return this.repositories.setChecks(user.id, id, body);
  }

  @Patch(":id")
  update(
    @CurrentUser() user: AuthUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodBodyPipe(UpdateRepositoryRequestSchema)) body: UpdateRepositoryRequest,
  ): Promise<RepositorySummary> {
    return this.repositories.setEnabled(user.id, id, body.enabled);
  }
}
