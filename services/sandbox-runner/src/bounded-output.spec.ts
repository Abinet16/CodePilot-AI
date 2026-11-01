import { BoundedOutput } from "./bounded-output";

describe("BoundedOutput", () => {
  it("keeps everything while under the limits", () => {
    const out = new BoundedOutput(10, 10);
    out.push(Buffer.from("hello "));
    out.push(Buffer.from("world"));
    expect(out.toString()).toBe("hello world");
    expect(out.truncated).toBe(false);
  });

  it("keeps the head and the tail and counts what it dropped", () => {
    const out = new BoundedOutput(5, 5);
    for (const part of ["START", "-middle-", "-more-middle-", "THEEND"]) out.push(Buffer.from(part));
    expect(out.toString()).toBe("START\n… 22 bytes of output omitted …\nHEEND");
    expect(out.truncated).toBe(true);
    expect(out.totalBytes).toBe(32);
  });

  it("stays bounded no matter how much is written", () => {
    const out = new BoundedOutput(1_000, 1_000);
    const chunk = Buffer.alloc(64 * 1024, "x");
    for (let i = 0; i < 200; i++) out.push(chunk);
    expect(out.toString().length).toBeLessThan(2_100);
  });
});
