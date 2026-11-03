import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { DashboardResponse, UsageQuery, UsageQuerySchema, UsageReport } from "@codepilot/contracts";
import { AuthUser, CurrentUser, SessionGuard } from "../auth/session.guard";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { DashboardService } from "./dashboard.service";

@Controller()
@UseGuards(SessionGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("dashboard")
  overview(@CurrentUser() user: AuthUser): Promise<DashboardResponse> {
    return this.dashboard.overview(user.id);
  }

  @Get("usage")
  usage(@CurrentUser() user: AuthUser, @Query(new ZodBodyPipe(UsageQuerySchema, "query")) query: UsageQuery): Promise<UsageReport> {
    return this.dashboard.usage(user.id, query.days);
  }
}
