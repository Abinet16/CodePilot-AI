import { Module } from "@nestjs/common";
import { TaskLister } from "./task-lister";
import { TaskQueue } from "./task-queue";
import { TasksController } from "./tasks.controller";
import { TasksService } from "./tasks.service";

@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskQueue, TaskLister],
  exports: [TaskLister],
})
export class TasksModule {}
