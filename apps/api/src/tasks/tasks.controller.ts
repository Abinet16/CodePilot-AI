import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { CreateTaskRequest, CreateTaskRequestSchema, TaskDetail, TaskSummary } from "@codepilot/contracts";
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
}
