import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/** Validates a request body (or, with `part`, a query string) against a shared zod schema from @codepilot/contracts. */
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(
    private readonly schema: ZodType<T>,
    private readonly part: "body" | "query" = "body",
  ) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        message: `Invalid request ${this.part}`,
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return parsed.data;
  }
}
