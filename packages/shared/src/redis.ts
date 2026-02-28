/**
 * Shared Redis Client
 * 
 * Provides a singleton Redis connection for use across services.
 * Supports both standalone Redis and clustered deployments.
 */

import { createLogger } from './logger';

const logger = createLogger('redis');

// Redis client type (using ioredis which is bundled with bullmq)
let Redis: any;
let redisClient: any = null;
let isConnected = false;

function getRedisModule() {
  if (!Redis) {
    try {
      Redis = require('ioredis');
    } catch {
      logger.warn('[REDIS] ioredis not installed, Redis features disabled');
      return null;
    }
  }
  return Redis;
}

export interface RedisConfig {
  url?: string;
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
  retryDelayMs?: number;
}

function parseRedisUrl(url: string): { host: string; port: number; password?: string; db?: number } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port, 10) || 6379,
      password: parsed.password || undefined,
      db: parsed.pathname ? parseInt(parsed.pathname.slice(1), 10) || 0 : 0,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

/**
 * Get or create the shared Redis client
 */
export function getRedisClient(config?: RedisConfig): any {
  if (redisClient && isConnected) {
    return redisClient;
  }

  const RedisClass = getRedisModule();
  if (!RedisClass) {
    return null;
  }

  const redisUrl = config?.url || process.env.REDIS_URL;
  
  if (!redisUrl && !config?.host) {
    logger.warn('[REDIS] No Redis URL configured, Redis features disabled');
    return null;
  }

  const options = redisUrl 
    ? parseRedisUrl(redisUrl)
    : {
        host: config?.host || 'localhost',
        port: config?.port || 6379,
        password: config?.password,
        db: config?.db || 0,
      };

  redisClient = new RedisClass({
    ...options,
    keyPrefix: config?.keyPrefix || 'raahi:',
    maxRetriesPerRequest: config?.maxRetriesPerRequest || 3,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * (config?.retryDelayMs || 100), 3000);
      logger.warn(`[REDIS] Reconnecting (attempt ${times}), delay: ${delay}ms`);
      return delay;
    },
    lazyConnect: false,
  });

  redisClient.on('connect', () => {
    isConnected = true;
    logger.info(`[REDIS] Connected to ${options.host}:${options.port}`);
  });

  redisClient.on('error', (err: Error) => {
    logger.error('[REDIS] Connection error', { error: err.message });
  });

  redisClient.on('close', () => {
    isConnected = false;
    logger.warn('[REDIS] Connection closed');
  });

  return redisClient;
}

/**
 * Check if Redis is available
 */
export function isRedisAvailable(): boolean {
  return isConnected && redisClient !== null;
}

/**
 * Close Redis connection gracefully
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isConnected = false;
    logger.info('[REDIS] Connection closed');
  }
}

// ─── Convenience Helpers ─────────────────────────────────────────────────────

/**
 * Set a JSON value with optional TTL
 */
export async function setJson(key: string, value: any, ttlSeconds?: number): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    const json = JSON.stringify(value);
    if (ttlSeconds) {
      await client.setex(key, ttlSeconds, json);
    } else {
      await client.set(key, json);
    }
    return true;
  } catch (err) {
    logger.error(`[REDIS] setJson failed for key ${key}`, { error: err });
    return false;
  }
}

/**
 * Get a JSON value
 */
export async function getJson<T = any>(key: string): Promise<T | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error(`[REDIS] getJson failed for key ${key}`, { error: err });
    return null;
  }
}

/**
 * Delete a key
 */
export async function del(key: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    await client.del(key);
    return true;
  } catch (err) {
    logger.error(`[REDIS] del failed for key ${key}`, { error: err });
    return false;
  }
}

/**
 * Set hash field
 */
export async function hset(key: string, field: string, value: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    await client.hset(key, field, value);
    return true;
  } catch (err) {
    logger.error(`[REDIS] hset failed for ${key}:${field}`, { error: err });
    return false;
  }
}

/**
 * Get hash field
 */
export async function hget(key: string, field: string): Promise<string | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    return await client.hget(key, field);
  } catch (err) {
    logger.error(`[REDIS] hget failed for ${key}:${field}`, { error: err });
    return null;
  }
}

/**
 * Get all hash fields
 */
export async function hgetall(key: string): Promise<Record<string, string> | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    const result = await client.hgetall(key);
    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    logger.error(`[REDIS] hgetall failed for ${key}`, { error: err });
    return null;
  }
}

/**
 * Delete hash field
 */
export async function hdel(key: string, field: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    await client.hdel(key, field);
    return true;
  } catch (err) {
    logger.error(`[REDIS] hdel failed for ${key}:${field}`, { error: err });
    return false;
  }
}

/**
 * Add to set
 */
export async function sadd(key: string, ...members: string[]): Promise<number> {
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await client.sadd(key, ...members);
  } catch (err) {
    logger.error(`[REDIS] sadd failed for ${key}`, { error: err });
    return 0;
  }
}

/**
 * Remove from set
 */
export async function srem(key: string, ...members: string[]): Promise<number> {
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await client.srem(key, ...members);
  } catch (err) {
    logger.error(`[REDIS] srem failed for ${key}`, { error: err });
    return 0;
  }
}

/**
 * Get all set members
 */
export async function smembers(key: string): Promise<string[]> {
  const client = getRedisClient();
  if (!client) return [];

  try {
    return await client.smembers(key);
  } catch (err) {
    logger.error(`[REDIS] smembers failed for ${key}`, { error: err });
    return [];
  }
}

/**
 * Check if member in set
 */
export async function sismember(key: string, member: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    return (await client.sismember(key, member)) === 1;
  } catch (err) {
    logger.error(`[REDIS] sismember failed for ${key}`, { error: err });
    return false;
  }
}

/**
 * Set with expiry (for rate limiting, sessions, etc.)
 */
export async function setex(key: string, seconds: number, value: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;

  try {
    await client.setex(key, seconds, value);
    return true;
  } catch (err) {
    logger.error(`[REDIS] setex failed for ${key}`, { error: err });
    return false;
  }
}

/**
 * Increment a counter
 */
export async function incr(key: string): Promise<number> {
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await client.incr(key);
  } catch (err) {
    logger.error(`[REDIS] incr failed for ${key}`, { error: err });
    return 0;
  }
}

/**
 * Get TTL of a key
 */
export async function ttl(key: string): Promise<number> {
  const client = getRedisClient();
  if (!client) return -2;

  try {
    return await client.ttl(key);
  } catch (err) {
    logger.error(`[REDIS] ttl failed for ${key}`, { error: err });
    return -2;
  }
}

/**
 * Publish to a channel (for pub/sub)
 */
export async function publish(channel: string, message: string): Promise<number> {
  const client = getRedisClient();
  if (!client) return 0;

  try {
    return await client.publish(channel, message);
  } catch (err) {
    logger.error(`[REDIS] publish failed for channel ${channel}`, { error: err });
    return 0;
  }
}
