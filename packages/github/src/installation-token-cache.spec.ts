import { InstallationTokenCache } from "./installation-token-cache";

describe("InstallationTokenCache", () => {
  let now: number;
  let minted: number;
  const mint = jest.fn(async () => {
    minted++;
    return { token: `token-${minted}`, expiresAt: new Date(now + 60 * 60_000) };
  });

  beforeEach(() => {
    now = Date.UTC(2026, 9, 28);
    minted = 0;
    mint.mockClear();
  });

  const cache = () => new InstallationTokenCache(mint, 5 * 60_000, () => now);

  it("reuses a token until it is close to expiry", async () => {
    const c = cache();
    expect(await c.get(1n)).toBe("token-1");
    now += 50 * 60_000;
    expect(await c.get(1n)).toBe("token-1");
    now += 6 * 60_000; // within the 5 minute refresh margin
    expect(await c.get(1n)).toBe("token-2");
  });

  it("shares one in-flight mint between concurrent callers", async () => {
    const c = cache();
    const tokens = await Promise.all([c.get(7n), c.get(7n), c.get(7n)]);
    expect(new Set(tokens)).toEqual(new Set(["token-1"]));
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("keeps installations separate and supports invalidation", async () => {
    const c = cache();
    expect(await c.get(1n)).toBe("token-1");
    expect(await c.get(2n)).toBe("token-2");
    c.invalidate(1n);
    expect(await c.get(1n)).toBe("token-3");
  });

  it("does not cache failures", async () => {
    mint.mockRejectedValueOnce(new Error("GitHub down"));
    const c = cache();
    await expect(c.get(1n)).rejects.toThrow("GitHub down");
    expect(await c.get(1n)).toBe("token-1");
  });
});
