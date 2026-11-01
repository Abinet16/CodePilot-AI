/**
 * Collects a process's output in bounded memory: the first `headBytes` and the
 * last `tailBytes` are kept, everything in between is only counted. A check
 * that prints gigabytes cannot exhaust the worker.
 */
export class BoundedOutput {
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailLength = 0;
  private total = 0;

  constructor(
    private readonly headBytes: number,
    private readonly tailBytes: number,
  ) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.head.length < this.headBytes) {
      const take = Math.min(this.headBytes - this.head.length, chunk.length);
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailLength += chunk.length;
    while (this.tailLength - this.tail[0]!.length >= this.tailBytes) {
      this.tailLength -= this.tail.shift()!.length;
    }
  }

  get totalBytes(): number {
    return this.total;
  }

  get truncated(): boolean {
    return this.total > this.head.length + this.tailLength || this.tailLength > this.tailBytes;
  }

  /** The kept output as text, with a marker where bytes were dropped. */
  toString(): string {
    let tail = Buffer.concat(this.tail);
    if (tail.length > this.tailBytes) tail = tail.subarray(tail.length - this.tailBytes);
    const dropped = this.total - this.head.length - tail.length;
    const marker = dropped > 0 ? `\n… ${dropped.toLocaleString("en-US")} bytes of output omitted …\n` : "";
    return this.head.toString("utf8") + marker + tail.toString("utf8");
  }
}
