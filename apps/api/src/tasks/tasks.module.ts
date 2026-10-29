import { Module } from "@nestjs/common";
import { TaskQueue } from "./task-queue";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";

@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskQueue],
})
export class TasksModule {}
