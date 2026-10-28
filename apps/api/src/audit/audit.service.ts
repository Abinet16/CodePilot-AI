import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { redact } from "./redact";

export interface AuditEntry {
  action: string;
  userId?: string | null;
  taskId?: string | null;
  metadata?: Record<string, unknown>;
}

type Db = Pick<Prisma.TransactionClient, "auditLog">;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass `tx` to make the audit row commit or roll back with the action it records. */
  async record(entry: AuditEntry, tx: Db = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        taskId: entry.taskId ?? null,
        metadata: redact(entry.metadata ?? {}) as Prisma.InputJsonObject,
      },
    });
  }
}
