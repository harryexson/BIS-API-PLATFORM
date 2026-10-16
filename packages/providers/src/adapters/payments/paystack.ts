import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Paystack payment provider adapter (Nigeria / African expansion corridor).
 *
 * Uses the Paystack Transaction API (https://api.paystack.co/transaction/initialize).
 * Paystack's charge flow is redirect-based (it returns an authorization_url
 * rather than an immediate charge result), which this adapter surfaces as a
 * "success" once the transaction is initialized — final settlement status
 * arrives via the charge.success webhook, same as Stripe's async webhook path.
 *
 * The customer's email (required by Paystack's initialize call) comes from
 * `payload.metadata.email`. Previously a fabricated `<appId>@bis-platform
 * .invalid` address was sent (gap register E8); without a real email this
 * adapter now falls back to simulated processing outside production and
 * refuses (throws) in production.
 *
 * Idempotency/reference: Paystack's `reference` must be unique per
 * transaction and only allows `-`, `.`, `=` and alphanumerics (no `_`), so
 * the deterministic identity is built with '-' separators:
 * bis-<payment_transaction_id>-<client key | 'default'> (client keys with
 * other characters are digested). Previously `bis_<appId>_<Date.now()>` —
 * banned, and not even valid for Paystack's own character set (E7).
 *
 * Environment variables:
 *   PAYSTACK_SECRET_KEY — sk_test_... or sk_live_...
 */
export class PaystackProvider extends BaseProvider {
  private baseUrl = 'https://api.paystack.co';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.PAYSTACK_SECRET_KEY || '';
  }

  // Previously inherited BaseProvider's unconditional `true` (gap register E2).
  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'NGN' } = payload;
    const email = typeof payload.metadata?.email === 'string' && payload.metadata.email ? payload.metadata.email : undefined;
    const startTime = Date.now();

    if (!this.apiKey || !email) {
      this.refuseSimulatedFallbackInProduction({
        missingCredentials: this.apiKey ? [] : ['PAYSTACK_SECRET_KEY'],
        missingInputs: email ? [] : ['metadata.email'],
      });
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    const reference = this.paymentIdempotencyIdentity(payload, {
      maxLength: 100,
      separator: '-',
      allowedChars: /^[A-Za-z0-9.=-]+$/,
    });

    try {
      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/transaction/initialize`,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: {
          email,
          amount: Math.round(amount * 100), // kobo
          currency: currency.toUpperCase(),
          reference,
          metadata: { appId, decisionReason },
        },
        timeoutMs: 30_000,
        maxAttempts: 2,
        // See the catch block: nothing this call does can move money, so
        // retrying it is harmless (a duplicate `reference` is rejected).
        retryAmbiguous: true,
      });

      const latency = Date.now() - startTime;

      if (!res.body?.status) {
        throw new Error(`Paystack API error: ${res.status} - ${res.body?.message || JSON.stringify(res.body)}`);
      }

      const data = res.body.data;
      const feePercent = this.config.transactionFeePercent || 1.5;
      const feeFlat = this.config.transactionFeeFlat || 0.0;
      const cost = (amount * feePercent) / 100 + feeFlat;

      return {
        id: data.reference,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        // Initializing a transaction only creates the checkout session — it
        // does not confirm the customer has actually paid. Real settlement
        // arrives later via the charge.success webhook, same as Stripe's
        // async confirmation path.
        status: 'pending',
        amount,
        currency,
        latency,
        cost,
        decisionReason,
        payload,
        response: data,
      };
    } catch (err: any) {
      // Phase 11-12 (A10/E4) — Paystack is the one adapter where EVERY
      // failure is a definite non-charge, including a timeout or a 5xx:
      // /transaction/initialize only creates a hosted-checkout session and
      // returns its authorization_url; no money moves until the customer
      // opens that URL and pays. If the response was lost, nobody ever
      // received the URL, so the session can never be paid. (A successful
      // initialize is reported as 'pending', which the router never fails
      // over.) So this deliberately stays 'failed' — classified, not
      // flattened.
      return this.paymentFailureEvent({
        appId, payload, decisionReason, startTime, amount, currency,
        err: this.definiteFailure(err?.message || String(err)),
        idPrefix: 'err_',
      });
    }
  }

  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    const { amount = 10, currency = 'NGN' } = payload;
    const reference = `bis_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    const feePercent = this.config.transactionFeePercent || 1.5;
    const feeFlat = this.config.transactionFeeFlat || 0.0;
    const cost = (amount * feePercent) / 100 + feeFlat;

    return {
      id: reference,
      timestamp: new Date().toISOString(),
      appId,
      category: 'payment',
      providerId: this.config.id,
      status: 'success',
      amount,
      currency,
      latency,
      cost,
      decisionReason,
      payload,
      response: {
        reference,
        access_code: randomUUID().replace(/-/g, '').slice(0, 12),
        authorization_url: `https://checkout.paystack.com/${reference}`,
      },
    };
  }
}
