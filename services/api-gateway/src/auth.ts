import { Request, Response, NextFunction } from 'express';
import {
  ApplicationRegistry,
  applicationRepository,
  apiKeyRepository,
} from '@company/database';

export interface AuthOptions {
  adminKey?: string;
  rateLimit?: { windowMs: number; max: number };
}

type AuthedRequest = Request & {
  appId?: string;
  application?: { id: string; slug: string; name: string };
};

export class AuthService {
  private registry: ApplicationRegistry | null = null;
  private hits = new Map<string, { count: number; resetAt: number }>();
  private rate: { windowMs: number; max: number };

  constructor(private opts: AuthOptions = {}) {
    this.rate = opts.rateLimit || { windowMs: 60_000, max: 100 };
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
      console.warn('[auth] PLATFORM_ADMIN_KEY is not set; admin endpoints are OPEN in production');
    }
    return true;
  }

  rateAllowed(key: string): boolean {
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || rec.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.rate.windowMs });
      return true;
    }
    rec.count += 1;
    return rec.count <= this.rate.max;
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

  const rateLimit = (req: Request, res: Response, next: NextFunction) => {
    const id = auth.extractKey(req) || req.ip || 'anonymous';
    if (!auth.rateAllowed(id)) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    next();
  };

  return { apiKey, admin, rateLimit };
}
