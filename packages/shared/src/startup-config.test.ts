import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateStartupConfig, assertStartupConfig } from './startup-config';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('validateStartupConfig', () => {
  it('fails when DATABASE_URL is missing, even outside production', () => {
    const result = validateStartupConfig(env({ NODE_ENV: 'development' }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
  });

  it('passes with only DATABASE_URL set outside production', () => {
    const result = validateStartupConfig(
      env({ NODE_ENV: 'development', DATABASE_URL: 'postgres://x' }),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails in production when WEBHOOK_HMAC_SECRET, SECRET_ENCRYPTION_KEY, or PLATFORM_ADMIN_KEY are missing', () => {
    const result = validateStartupConfig(
      env({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('WEBHOOK_HMAC_SECRET'))).toBe(true);
    expect(result.errors.some((e) => e.includes('SECRET_ENCRYPTION_KEY'))).toBe(true);
    expect(result.errors.some((e) => e.includes('PLATFORM_ADMIN_KEY'))).toBe(true);
  });

  it('does not require the production-only secrets outside production', () => {
    const result = validateStartupConfig(
      env({ NODE_ENV: 'development', DATABASE_URL: 'postgres://x' }),
    );
    expect(result.errors.some((e) => e.includes('WEBHOOK_HMAC_SECRET'))).toBe(false);
    expect(result.errors.some((e) => e.includes('SECRET_ENCRYPTION_KEY'))).toBe(false);
    expect(result.errors.some((e) => e.includes('PLATFORM_ADMIN_KEY'))).toBe(false);
  });

  it('passes in production once every required var is set', () => {
    const result = validateStartupConfig(
      env({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x',
        WEBHOOK_HMAC_SECRET: 'a'.repeat(32),
        SECRET_ENCRYPTION_KEY: 'b'.repeat(32),
        PLATFORM_ADMIN_KEY: 'c'.repeat(32),
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('never requires REDIS_URL — the rate limiter and job store both have a working in-memory fallback', () => {
    const result = validateStartupConfig(
      env({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x',
        WEBHOOK_HMAC_SECRET: 'a'.repeat(32),
        SECRET_ENCRYPTION_KEY: 'b'.repeat(32),
        PLATFORM_ADMIN_KEY: 'c'.repeat(32),
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('assertStartupConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits the process with a non-zero code and logs every error when invalid', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    assertStartupConfig(env({ NODE_ENV: 'production' }));

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    const loggedText = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(loggedText).toMatch(/DATABASE_URL|WEBHOOK_HMAC_SECRET/);
  });

  it('does not exit when configuration is valid', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    assertStartupConfig(
      env({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://x',
      }),
    );

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
