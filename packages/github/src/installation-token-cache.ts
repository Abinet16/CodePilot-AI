export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

/**
 * In-memory cache of installation access tokens (valid ~1 hour). Tokens are
 * refreshed before expiry, concurrent callers share one in-flight request,
 * and nothing is ever written to the database, the queue, or logs.
 */
export class InstallationTokenCache {
  private readonly tokens = new Map<string, InstallationToken>();
  private readonly inflight = new Map<string, Promise<InstallationToken>>();

  constructor(
    private readonly mint: (installationId: bigint) => Promise<InstallationToken>,
    private readonly refreshMarginMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(installationId: bigint): Promise<string> {
    const key = installationId.toString();
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt.getTime() - this.refreshMarginMs > this.now()) return cached.token;

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.mint(installationId)
        .then((minted) => {
          this.tokens.set(key, minted);
          return minted;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return (await pending).token;
  }

  /** Drop a token early, e.g. when the installation is deleted or suspended. */
  invalidate(installationId: bigint): void {
    this.tokens.delete(installationId.toString());
  }
}
