import { FactoryProvider, Inject, Injectable, OnApplicationShutdown } from "@nestjs/common";
import Redis from "ioredis";
import { API_CONFIG, ApiConfig } from "../config";

export const REDIS = Symbol("REDIS");
export const InjectRedis = () => Inject(REDIS);

export const redisProvider: FactoryProvider<Redis> = {
  provide: REDIS,
  inject: [API_CONFIG],
  // BullMQ requires maxRetriesPerRequest: null on shared connections.
  useFactory: (config: ApiConfig) => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true }),
};

/** Closes the shared connection after modules (e.g. queues using it) have shut down. */
@Injectable()
export class RedisShutdown implements OnApplicationShutdown {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === "wait" || this.redis.status === "end") return;
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
