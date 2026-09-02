import { idempotencyRecordRepository } from '@company/database';

/**
 * P0: Platform-level idempotency service.
 *
 * Scoped by (appId, tenantId, operation, idempotencyKey) to prevent:
 * - Cross-application key collisions
 * - Cross-tenant key collisions
 * - Different operations with the same key returning wrong cached results
 *
 * Provider-specific idempotency (e.g., Stripe's Idempotency-Key header)
 * is an additional internal layer on top of this.
 */
export class PlatformIdempotencyService {
  /**
   * Check if an idempotency key has already been claimed.
   * If not, atomically claim it for this operation.
   *
   * @returns { claimed: true, recordId } if this is the first request
   * @returns { claimed: false, existingResult } if already completed
   * @returns { claimed: false } if currently processing
   */
  async checkAndClaim(
    appId: string,
    tenantId: string,
    operation: string,
    idempotencyKey: string,
    ttlMs: number = 300_000, // 5 minutes default
  ): Promise<{ claimed: boolean; existingResult?: any; recordId?: string }> {
    // 1. Check if active record exists
    const existing = await idempotencyRecordRepository.findActive(
      appId, tenantId, operation, idempotencyKey,
    );

    if (existing) {
      if (existing.status === 'completed') {
        return { claimed: false, existingResult: existing.result };
      }
      if (existing.status === 'processing') {
        return { claimed: false, existingResult: null };
      }
      // If failed or expired, allow re-claim
    }

    // 2. Create new record
    const expiresAt = new Date(Date.now() + ttlMs);
    const record = await idempotencyRecordRepository.create({
      appId,
      tenantId,
      operation,
      idempotencyKey,
      status: 'processing',
      expiresAt,
    });

    return { claimed: true, recordId: record.id };
  }

  /**
   * Mark an idempotency record as completed with the result.
   */
  async complete(recordId: string, result: any): Promise<void> {
    await idempotencyRecordRepository.complete(recordId, result);
  }

  /**
   * Mark an idempotency record as failed.
   */
  async fail(recordId: string, error: string): Promise<void> {
    await idempotencyRecordRepository.fail(recordId, error);
  }
}
