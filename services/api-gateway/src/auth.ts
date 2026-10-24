import { Request, Response, NextFunction } from 'express';
import {
  ApplicationRegistry,
  applicationRepository,
  apiKeyRepository,
  currentDeploymentTier,
} from '@company/database';
import {
  RateLimiterMemory,
  RateLimiterRedis,
} from 'rate-limiter-flexible';

export interface AuthOptions {
  /** General budget: API traffic (per application once authenticated, else per IP), admin routes, public reads. */
  rateLimit?: { windowMs: number; max: number };
  /**
   * Phase 14 (C15): strict per-IP budget for credential / abuse-sensitive
   * public routes — portal login & signup, checkout pay.
   */
  authRateLimit?: { windowMs: number; max: number };
  /**
   * Phase 20-21 (gap register PHASE14-06 / C7): a DEDICATED per-IP counter
   * of FAILED admin-token attempts (a wrong x-admin-token), separate from
   * the general per-IP budget above. `max` failures inside `windowMs` lock
   * that address out of admin auth for the rest of the window.
   */
  adminAuthFailureLimit?: { windowMs: number; max: number };
}

/** What the dedicated failed-admin-attempt counter says about one caller. */
export interface AdminAuthLockState {
  locked: boolean;
  failures: number;
  retryAfterMs: number;
}

type AuthResult = { ok: boolean; appId?: string; error?: string };

type AuthedRequest = Request & {
  appId?: string;
  application?: { id: string; slug: string; name: string };
  /** Set by the rateLimit middleware so apiKey doesn't look the same key up twice. */
  preAuth?: { raw: string; result: AuthResult };
};

export type RateTier = 'api' | 'auth';

// One lazily created ioredis connection shared by every limiter.
let sharedRedisClient: unknown;
function redisClient(redisUrl: string): unknown {
  if (!sharedRedisClient) {
    // ioredis is an optional dependency — load it lazily at call time.
    // If the module isn't installed, this throws and the caller falls back to memory.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const Redis = require('ioredis') as typeof import('ioredis').default;
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    // Phase 14: start connecting NOW. With lazyConnect + no offline queue
    // and nobody calling connect(), the first command was rejected ("Stream
    // isn't writeable") just to trigger the connection, so that request was
    // counted only by this process's in-memory insurance limiter instead of
    // the shared Redis bucket. Connection errors are handled by ioredis's own
    // retry; until it's ready, consume() falls back to the insurance limiter.
    client.on('error', () => undefined);
    client.connect().catch(() => undefined);
    sharedRedisClient = client;
  }
  return sharedRedisClient;
}

// Redis key namespace for every gateway limiter. All replicas of one
// deployment must share it (that's what makes the limit distributed); it's
// configurable so separate environments/test runs on one Redis don't share
// buckets.
const RATE_LIMIT_KEY_PREFIX = process.env.RATE_LIMIT_KEY_PREFIX || 'rl';

function createRateLimiter(opts: { windowMs: number; max: number }, keyPrefix = RATE_LIMIT_KEY_PREFIX) {
  const redisUrl = process.env.REDIS_URL;
  const memoryFallback = new RateLimiterMemory({
    points: opts.max,
    duration: Math.ceil(opts.windowMs / 1000),
  });

  // 'memory' is createStore()'s explicit single-process sentinel
  // (@company/workers), not a Redis host — Phase 19: treat it as "no Redis"
  // here too instead of connecting to a host named "memory".
  const redisConfigured = Boolean(redisUrl) && redisUrl !== 'memory';
  if (redisUrl && redisConfigured) {
    try {
      const client = redisClient(redisUrl);
      const limiter = new RateLimiterRedis({
        storeClient: client,
        keyPrefix,
        points: opts.max,
        duration: Math.ceil(opts.windowMs / 1000),
        insuranceLimiter: memoryFallback,
      });
      return { type: 'redis' as const, limiter, client: client as { status?: string }, redisConfigured: true };
    } catch {
      // ioredis not installed or Redis unreachable — use in-memory
    }
  }
  return {
    type: 'memory' as const,
    limiter: memoryFallback,
    client: null,
    redisConfigured,
  };
}

export class AuthService {
  private registry: ApplicationRegistry | null = null;
  private rateLimiter: ReturnType<typeof createRateLimiter>;
  private authRateLimiter: ReturnType<typeof createRateLimiter>;
  private adminFailureLimiter: ReturnType<typeof createRateLimiter>;
  private rate: { windowMs: number; max: number };
  readonly adminFailure: { windowMs: number; max: number };

  constructor(private opts: AuthOptions = {}) {
    this.rate = opts.rateLimit || { windowMs: 60_000, max: 100 };
    this.rateLimiter = createRateLimiter(this.rate);
    this.authRateLimiter = createRateLimiter(
      opts.authRateLimit || { windowMs: 15 * 60_000, max: 20 },
      `${RATE_LIMIT_KEY_PREFIX}-auth`,
    );
    this.adminFailure = opts.adminAuthFailureLimit || { windowMs: 15 * 60_000, max: 10 };
    // Same Redis (and therefore shared by every replica) as the other
    // limiters, own key namespace: `<prefix>-admin-fail:ip:<address>`.
    this.adminFailureLimiter = createRateLimiter(this.adminFailure, `${RATE_LIMIT_KEY_PREFIX}-admin-fail`);
    try {
      this.registry = new ApplicationRegistry(applicationRepository, apiKeyRepository);
    } catch {
      this.registry = null;
    }
  }

  get production(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  extractKey(req: Request): string | undefined {
    const header = req.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      return header.slice(7);
    }
    const key = req.headers['x-api-key'];
    return typeof key === 'string' ? key : undefined;
  }

  async authenticate(
    raw: string | undefined,
    fallbackAppId?: string,
  ): Promise<{ ok: boolean; appId?: string; error?: string }> {
    if (raw) {
      if (!this.registry) {
        // P0: Fail closed — never trust client-supplied appId
        return { ok: false, error: 'Authentication service unavailable' };
      }
      try {
        // Gap register C9: the key must belong to THIS deployment's tier.
        // Production routes only to 'live' providers with real credentials,
        // so a 'test' key is refused there (and a 'live' key is refused by
        // any non-production deployment). Previously no environment was
        // passed and the registry's check never ran.
        const res = await this.registry.authenticateApplication(raw, currentDeploymentTier());
        if (!res.authenticated || !res.application) {
          return { ok: false, error: res.error || 'Invalid API key' };
        }
        return { ok: true, appId: res.application.slug };
      } catch {
        // P0: Fail closed — never trust client-supplied appId
        return { ok: false, error: 'Authentication service unavailable' };
      }
    }

    if (this.production) {
      return { ok: false, error: 'API key required' };
    }
    // P0: Fail closed — require API key in all environments
    return { ok: false, error: 'API key required' };
  }

  // P2-4: Redis-backed rate limiting with in-memory fallback
  async rateAllowed(key: string, tier: RateTier = 'api'): Promise<boolean> {
    const limiter = tier === 'auth' ? this.authRateLimiter : this.rateLimiter;
    try {
      await limiter.limiter.consume(key);
      return true;
    } catch (rejRes: any) {
      // Rate limit exceeded — rejRes contains msBeforeNext
      return false;
    }
  }

  /**
   * Phase 20-21: is this caller locked out of admin auth by its own FAILED
   * attempts? Read-only (a get, not a consume): successful and token-less
   * requests never count. Checked BEFORE any token is compared, so a
   * locked-out caller can't use the gateway as an oracle even with the
   * correct token.
   */
  async adminAuthLockState(ip: string): Promise<AdminAuthLockState> {
    try {
      const res = await this.adminFailureLimiter.limiter.get(`ip:${ip}`);
      const failures = res?.consumedPoints ?? 0;
      return {
        locked: failures >= this.adminFailure.max,
        failures,
        retryAfterMs: res?.msBeforeNext ?? 0,
      };
    } catch {
      // The Redis limiter falls back to its in-memory insurance limiter on a
      // store error; a get that still fails is treated as "no failures yet"
      // — the general per-IP budget keeps bounding the caller meanwhile.
      return { locked: false, failures: 0, retryAfterMs: 0 };
    }
  }

  /**
   * Phase 20-21: count one FAILED admin-token attempt against the caller.
   * `locked` is true once this attempt went past the allowed failures —
   * atomic in the store (one consume), so a concurrent burst of wrong
   * guesses gets exactly `max` rejections-by-token-check and nothing more.
   */
  async recordAdminAuthFailure(ip: string): Promise<AdminAuthLockState> {
    try {
      const res = await this.adminFailureLimiter.limiter.consume(`ip:${ip}`);
      return { locked: false, failures: res.consumedPoints, retryAfterMs: res.msBeforeNext };
    } catch (rejRes: any) {
      if (rejRes instanceof Error) {
        // A store error, not a rejection: fail closed for this attempt.
        return { locked: true, failures: this.adminFailure.max, retryAfterMs: this.adminFailure.windowMs };
      }
      return { locked: true, failures: rejRes?.consumedPoints ?? this.adminFailure.max, retryAfterMs: rejRes?.msBeforeNext ?? 0 };
    }
  }

  /** Phase 20-21: a successful admin authentication clears that caller's failure count. */
  async clearAdminAuthFailures(ip: string): Promise<void> {
    try {
      await this.adminFailureLimiter.limiter.delete(`ip:${ip}`);
    } catch {
      // Best effort: a stale count only makes the lockout stricter.
    }
  }

  /** Give back one point consumed on the general budget (see createMiddleware's rateLimit). */
  async rateRefund(key: string): Promise<void> {
    try {
      await this.rateLimiter.limiter.reward(key, 1);
    } catch {
      // Best effort: a failed refund only makes the limit stricter.
    }
  }

  /**
   * Phase 19 (gap register B13 / PHASE14-01 residual): `storeBacked` is true
   * only while the shared Redis connection is actually usable. It used to be
   * `type === 'redis'` — true whenever REDIS_URL was set, even while every
   * consume() was silently falling through to this process's in-memory
   * insurance limiter (a per-replica limit, not the configured cluster-wide
   * one).
   */
  getRateLimiterInfo(): { type: string; storeBacked: boolean; redisConfigured: boolean; connection: string } {
    const { type, client, redisConfigured } = this.rateLimiter;
    const connection = client ? client.status ?? 'unknown' : 'none';
    return {
      type,
      storeBacked: type === 'redis' && connection === 'ready',
      redisConfigured,
      connection,
    };
  }
}

/**
 * The caller's network address: the only rate-limit identity a caller can't
 * change per request by editing a header. (Behind a reverse proxy this is
 * the proxy's address unless TRUST_PROXY names that proxy's exact hop count
 * or address — see trust-proxy.ts; X-Forwarded-For entries written by the
 * client itself are never trusted.)
 */
export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

const tooMany = (res: Response) => res.status(429).json({ error: 'Rate limit exceeded' });

export function createMiddleware(auth: AuthService) {
  const apiKey = async (req: Request, res: Response, next: NextFunction) => {
    const key = auth.extractKey(req);
    const r = req as AuthedRequest;
    const result =
      key && r.preAuth?.raw === key ? r.preAuth.result : await auth.authenticate(key, r.body?.appId);
    if (!result.ok) {
      return res.status(401).json({ error: result.error || 'Unauthorized' });
    }
    r.appId = result.appId;
    if (r.body) r.body.appId = result.appId;
    next();
  };

  // C14 FIX: the bucket used to be `extractKey(req) || req.ip` — the raw,
  // unvalidated x-api-key / Bearer string — so a fresh random header bought a
  // fresh bucket on every request (unlimited admin-token guesses against
  // /api/dashboard/admin/verify, unlimited API-key guesses on /v1/api).
  //
  // Now every request is first charged to the caller's IP, BEFORE any key is
  // looked up — so a throttled caller can't use the gateway as a key-validity
  // oracle, and a concurrent burst can't race past the limit while lookups
  // are in flight. Only a key that really authenticates moves the charge to
  // its application's bucket (the IP point is refunded), so legitimate
  // tenants keep their own per-application budget even when they share an
  // address. Failed keys stay charged to the IP.
  const rateLimit = async (req: Request, res: Response, next: NextFunction) => {
    const ipBucket = `ip:${clientIp(req)}`;
    if (!(await auth.rateAllowed(ipBucket))) return tooMany(res);

    const raw = auth.extractKey(req);
    if (!raw) return next();
    const result = await auth.authenticate(raw);
    (req as AuthedRequest).preAuth = { raw, result };
    if (!result.ok || !result.appId) return next();

    await auth.rateRefund(ipBucket);
    if (!(await auth.rateAllowed(`app:${result.appId}`))) return tooMany(res);
    next();
  };

  // C14 FIX: admin routes authenticate with x-admin-token, never x-api-key,
  // so any key header is irrelevant to them — bucket by caller IP only.
  // Also used for public, unauthenticated reads (C15).
  const ipRateLimit = async (req: Request, res: Response, next: NextFunction) => {
    if (!(await auth.rateAllowed(`ip:${clientIp(req)}`))) return tooMany(res);
    next();
  };

  // C15 FIX: strict per-IP budget for credential / abuse-sensitive routes.
  const authRateLimit = async (req: Request, res: Response, next: NextFunction) => {
    if (!(await auth.rateAllowed(`ip:${clientIp(req)}`, 'auth'))) return tooMany(res);
    next();
  };

  return { apiKey, rateLimit, ipRateLimit, authRateLimit };
}
