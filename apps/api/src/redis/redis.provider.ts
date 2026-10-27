import { FactoryProvider, Inject } from "@nestjs/common";
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
