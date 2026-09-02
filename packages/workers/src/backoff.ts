import { RetryConfig } from './types';

export function computeBackoff(attempt: number, cfg: RetryConfig): number {
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(cfg.factor, attempt - 1));
  const jitter = Math.random() * Math.floor(exp * 0.2);
  return Math.min(cfg.maxDelayMs, Math.floor(exp + jitter));
}
