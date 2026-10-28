import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/** Validates a request body against a shared zod schema from @codepilot/contracts. */
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        message: "Invalid request body",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    return parsed.data;
  }
}
