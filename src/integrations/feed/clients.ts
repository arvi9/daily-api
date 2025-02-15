import { FeedConfig, FeedResponse, IFeedClient } from './types';
import fetch, { RequestInit } from 'node-fetch';
import { fetchOptions as globalFetchOptions } from '../../http';
import pRetry, { AbortError } from 'p-retry';
import { IORedisPool } from '@dailydotdev/ts-ioredis-pool';
import { Context } from '../../Context';
import { ONE_DAY_IN_SECONDS } from '../../redis';

type RawFeedServiceResponse = {
  data: { post_id: string; metadata: Record<string, string> }[];
};

/**
 * Naive implementation of a feed client that fetches the feed from the feed service
 */
export class FeedClient implements IFeedClient {
  private readonly url: string;
  private readonly fetchOptions: RequestInit;

  constructor(
    url = process.env.INTERNAL_FEED,
    fetchOptions: RequestInit = globalFetchOptions,
  ) {
    this.url = url;
    this.fetchOptions = fetchOptions;
  }

  private async internalFetchFeed(
    config: FeedConfig,
  ): Promise<RawFeedServiceResponse> {
    const res = await fetch(this.url, {
      ...this.fetchOptions,
      method: 'POST',
      body: JSON.stringify(config),
    });
    if (res.ok) {
      const bodyText = await res.text();
      return JSON.parse(bodyText);
    }
    if (res.status < 500) {
      throw new AbortError(`feed service request is invalid: ${res.status}`);
    }
    throw new Error(`unexpecetd response from feed service: ${res.status}`);
  }

  async fetchFeed(ctx, feedId, config): Promise<FeedResponse> {
    const res = await pRetry(() => this.internalFetchFeed(config), {
      retries: 5,
    });
    if (!res?.data?.length) {
      ctx?.log.warn({ config }, 'empty response received from feed service');
      return [];
    }
    return res.data.map(({ post_id, metadata }) => [
      post_id,
      (metadata && JSON.stringify(metadata)) || null,
    ]);
  }
}

const CACHE_TTL = 3 * 60 * 1000;

/**
 * Feed client that caches the response in Redis
 */
export class CachedFeedClient implements IFeedClient {
  private readonly client: IFeedClient;
  private readonly redisPool: IORedisPool;

  constructor(client: IFeedClient, redisPool: IORedisPool) {
    this.client = client;
    this.redisPool = redisPool;
  }

  getCacheKeyPrefix(feedId: string): string {
    return `feeds:${feedId}`;
  }

  getCacheKey(userId: string | undefined, feedId: string): string {
    return `${this.getCacheKeyPrefix(feedId)}:${userId || 'anonymous'}`;
  }

  async shouldServeFromCache(
    offset: number,
    key: string,
    feedId?: string,
  ): Promise<boolean> {
    if (offset) {
      return true;
    }
    const updateKey = `${this.getCacheKeyPrefix(feedId)}:update`;
    const [lastGenerated, lastUpdated] = await this.redisPool.execute(
      async (client) => {
        return client.mget(`${key}:time`, updateKey);
      },
    );
    return !(
      !lastGenerated ||
      (lastUpdated && lastUpdated > lastGenerated) ||
      new Date().getTime() - new Date(lastGenerated).getTime() > CACHE_TTL
    );
  }

  async fetchFromCache(
    ctx: Context,
    feedId: string,
    config: FeedConfig,
  ): Promise<FeedResponse | undefined> {
    const { offset, page_size: pageSize } = config;
    const key = this.getCacheKey(config.user_id, feedId);
    const cachePromise = this.redisPool.execute(async (client) => {
      return client.get(`${key}:posts`);
    });
    if (await this.shouldServeFromCache(offset, key, feedId)) {
      const cachedFeed = JSON.parse(await cachePromise);
      if (cachedFeed?.length) {
        const page: string[] | [string, string | undefined][] =
          cachedFeed.slice(offset, pageSize + offset);
        // Support legacy cache that contains only post id
        if (page.length && typeof page[0] === 'string') {
          return (page as string[]).map((postId) => [postId, undefined]);
        }
        return page as [string, string | undefined][];
      }
    }
    return undefined;
  }

  async updateCache(
    feedId: string,
    config: FeedConfig,
    items: FeedResponse,
  ): Promise<void> {
    const key = this.getCacheKey(config.user_id, feedId);
    await this.redisPool.execute(async (client) => {
      const pipeline = client.pipeline();
      pipeline.set(
        `${key}:time`,
        new Date().toISOString(),
        'EX',
        ONE_DAY_IN_SECONDS,
      );
      pipeline.set(
        `${key}:posts`,
        JSON.stringify(items),
        'EX',
        ONE_DAY_IN_SECONDS,
      );
      return await pipeline.exec();
    });
  }

  async fetchFeed(ctx, feedId, config): Promise<FeedResponse> {
    const { offset, page_size: pageSize } = config;
    try {
      const cached = await this.fetchFromCache(ctx, feedId, config);
      if (cached) {
        return cached;
      }
    } catch (e) {
      ctx?.log.error({ err: e }, 'failed to get feed from cache');
    }
    const cloneConfig = { ...config };
    delete cloneConfig.offset;
    const feedRes = await this.client.fetchFeed(ctx, feedId, cloneConfig);
    if (feedRes.length) {
      // Don't wait for cache to update to gain some performance
      this.updateCache(feedId, config, feedRes);
    }
    return feedRes.slice(offset, pageSize + offset);
  }
}
