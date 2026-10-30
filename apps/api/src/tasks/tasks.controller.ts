import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApprovePlanRequest,
  ApprovePlanRequestSchema,
  CreateTaskRequest,
  CreateTaskRequestSchema,
  RequestPlanChangesRequest,
  RequestPlanChangesRequestSchema,
  TaskDetail,
  TaskSummary,
} from "@codepilot/contracts";
import { AuthUser, CurrentUser, SessionGuard } from "../auth/session.guard";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { TasksService } from "./tasks.service";

@Controller("tasks")
@UseGuards(SessionGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBodyPipe(CreateTaskRequestSchema)) body: CreateTaskRequest): Promise<TaskDetail> {
    return this.tasks.create(user.id, body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query("repositoryId", new ParseUUIDPipe({ optional: true })) repositoryId?: string,
  ): Promise<TaskSummary[]> {
    return this.tasks.list(user.id, repositoryId);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id", new ParseUUIDPipe()) id: string): Promise<TaskDetail> {
    return this.tasks.get(user.id, id);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param("id", new ParseUUIDPipe()) id: string): Promise<TaskDetail> {
    return this.tasks.cancel(user.id, id);
  }

  @Post(":id/plan/approve")
  @HttpCode(200)
  approvePlan(
    @CurrentUser() user: AuthUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodBodyPipe(ApprovePlanRequestSchema)) body: ApprovePlanRequest,
  ): Promise<TaskDetail> {
    return this.tasks.approvePlan(user.id, id, body.version);
  }

  @Post(":id/plan/request-changes")
  @HttpCode(200)
  requestPlanChanges(
    @CurrentUser() user: AuthUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodBodyPipe(RequestPlanChangesRequestSchema)) body: RequestPlanChangesRequest,
  ): Promise<TaskDetail> {
    return this.tasks.requestPlanChanges(user.id, id, body.version, body.feedback);
  }
}
