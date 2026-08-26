import { Request, Response, NextFunction } from 'express';
import {
  ApplicationRegistry,
  applicationRepository,
  apiKeyRepository,
} from '@company/database';
import {
  RateLimiterMemory,
  RateLimiterRedis,
} from 'rate-limiter-flexible';

export interface AuthOptions {
  adminKey?: string;
  rateLimit?: { windowMs: number; max: number };
}

type AuthedRequest = Request & {
  appId?: string;
  application?: { id: string; slug: string; name: string };
};

function createRateLimiter(opts: { windowMs: number; max: number }) {
  const redisUrl = process.env.REDIS_URL;
  const memoryFallback = new RateLimiterMemory({
    points: opts.max,
    duration: Math.ceil(opts.windowMs / 1000),
  });

  if (redisUrl) {
    try {
      // ioredis is an optional dependency — load it lazily at call time.
      // If the module isn't installed, this throws and we fall back to memory.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const Redis = require('ioredis') as typeof import('ioredis').default;
      const client = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      const limiter = new RateLimiterRedis({
        storeClient: client,
        keyPrefix: 'rl',
        points: opts.max,
        duration: Math.ceil(opts.windowMs / 1000),
        insuranceLimiter: memoryFallback,
      });
      return { type: 'redis' as const, limiter };
    } catch {
      // ioredis not installed or Redis unreachable — use in-memory
    }
  }
  return {
    type: 'memory' as const,
    limiter: memoryFallback,
  };
}

export class AuthService {
  private registry: ApplicationRegistry | null = null;
  private rateLimiter: ReturnType<typeof createRateLimiter>;
  private rate: { windowMs: number; max: number };

  constructor(private opts: AuthOptions = {}) {
    this.rate = opts.rateLimit || { windowMs: 60_000, max: 100 };
    this.rateLimiter = createRateLimiter(this.rate);
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
        if (this.production) {
          return { ok: false, error: 'Authentication service unavailable' };
        }
        return { ok: true, appId: fallbackAppId };
      }
      try {
        const res = await this.registry.authenticateApplication(raw);
        if (!res.authenticated || !res.application) {
          return { ok: false, error: res.error || 'Invalid API key' };
        }
        return { ok: true, appId: res.application.slug };
      } catch {
        if (this.production) {
          return { ok: false, error: 'Authentication service unavailable' };
        }
        return { ok: true, appId: fallbackAppId };
      }
    }

    if (this.production) {
      return { ok: false, error: 'API key required' };
    }
    return { ok: true, appId: fallbackAppId };
  }

  checkAdmin(req: Request): boolean {
    const configured = !!this.opts.adminKey;
    const header =
      (req.headers['x-admin-key'] as string) ||
      (req.headers['authorization'] as string) ||
      '';
    if (configured) {
      return header === this.opts.adminKey;
    }
    if (this.production) {
      return false;
    }
    return true;
  }

  // P2-4: Redis-backed rate limiting with in-memory fallback
  async rateAllowed(key: string): Promise<boolean> {
    try {
      await this.rateLimiter.limiter.consume(key);
      return true;
    } catch (rejRes: any) {
      // Rate limit exceeded — rejRes contains msBeforeNext
      return false;
    }
  }

  getRateLimiterInfo(): { type: string; storeBacked: boolean } {
    return {
      type: this.rateLimiter.type,
      storeBacked: this.rateLimiter.type === 'redis',
    };
  }
}

export function createMiddleware(auth: AuthService) {
  const apiKey = async (req: Request, res: Response, next: NextFunction) => {
    const key = auth.extractKey(req);
    const result = await auth.authenticate(key, (req as AuthedRequest).body?.appId);
    if (!result.ok) {
      return res.status(401).json({ error: result.error || 'Unauthorized' });
    }
    const r = req as AuthedRequest;
    r.appId = result.appId;
    if (r.body) r.body.appId = result.appId;
    next();
  };

  const admin = (req: Request, res: Response, next: NextFunction) => {
    if (!auth.checkAdmin(req)) {
      return res.status(403).json({ error: 'Admin key required' });
    }
    next();
  };

  const rateLimit = async (req: Request, res: Response, next: NextFunction) => {
    const id = auth.extractKey(req) || req.ip || 'anonymous';
    if (!(await auth.rateAllowed(id))) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    next();
  };

  return { apiKey, admin, rateLimit };
}
