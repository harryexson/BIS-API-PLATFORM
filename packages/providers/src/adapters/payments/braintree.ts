import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest, RefundResult } from '@company/schemas';

const CHARGE_MUTATION = `
mutation ChargeCreditCard($input: ChargeCreditCardInput!) {
  chargeCreditCard(input: $input) {
    transaction { id status amount { value currencyCode } }
  }
}`;

const REFUND_MUTATION = `
mutation RefundTransaction($input: RefundTransactionInput!) {
  refundTransaction(input: $input) {
    refund { id status amount { value currencyCode } }
  }
}`;

/**
 * Real Braintree payment provider adapter.
 *
 * Uses Braintree's GraphQL API (a single POST /graphql endpoint, not a
 * REST resource per operation — Braintree's own current integration path,
 * distinct from its older SOAP-derived Classic/NVP API). Facts below
 * (endpoint, auth scheme, mutation shape, status values, error envelope)
 * were verified via web search against Braintree's public GraphQL
 * documentation on 2026-09-25 (this environment's outbound network access
 * to braintreepayments.com/paypal.com is restricted — see
 * docs/IMPLEMENTATION_BASELINE.md §6 item 1 for the same constraint on
 * other adapters), not a live account. Treat as "built from real, current
 * documentation" rather than "certified against a live sandbox." The
 * TransactionStatus enum specifically is confirmed real (AUTHORIZED,
 * SUBMITTED_FOR_SETTLEMENT, SETTLING, SETTLED, PROCESSOR_DECLINED,
 * GATEWAY_REJECTED, FAILED, VOIDED all independently corroborated) but
 * not confirmed exhaustive — an unrecognized status reports as this
 * platform's 'unknown', never guessed at either way.
 *
 * Auth is HTTP Basic with `base64(publicKey:privateKey)`, plus a required
 * `Braintree-Version` header (an API version date, not a real credential).
 * Unlike every minor-unit-integer adapter in this package (Stripe/Adyen/
 * NMI), Braintree's GraphQL `Money` type takes amounts as **decimal
 * strings** (e.g. `"49.99"`), not cents — a real, easy-to-miss difference
 * this adapter gets right rather than silently multiplying by 100 like
 * the others.
 *
 * Like Stripe/NMI/Adyen, this gateway's `PaymentRequest` never collects
 * raw card data — `paymentToken` must be a pre-tokenized instrument.
 * Braintree's GraphQL charge mutation takes a `paymentMethodId` (a
 * client-tokenized nonce or a stored payment method token) directly,
 * which is exactly this gateway's `paymentToken` field — no extra
 * metadata field is required to use it, unlike Adyen's `shopperReference`
 * or Flutterwave's `email`. Without an API key/merchant id or a
 * `paymentToken`, this adapter falls back to simulated processing —
 * never a real call with an instrument to charge fabricated.
 *
 * `chargeCreditCard` captures funds immediately (no separate capture
 * step this platform would need to call), so AUTHORIZED/
 * SUBMITTED_FOR_SETTLEMENT/SETTLING/SETTLED are all treated as a
 * confirmed **charge** success here — the same "approved, money is
 * moving" convention this platform's other adapters already use (e.g.
 * Adyen's `Authorised` well before real bank settlement completes).
 * **Refunds are scored more conservatively**: only `SETTLED` is a
 * confirmed refund success; `SUBMITTED_FOR_SETTLEMENT`/`SETTLING`/
 * `AUTHORIZED` report `'unknown'` rather than a fabricated success — the
 * same asymmetry Stripe's own refund handling already applies here
 * (`succeeded` vs. `pending`/`requires_action`).
 *
 * Environment variables:
 *   BRAINTREE_PUBLIC_KEY
 *   BRAINTREE_PRIVATE_KEY
 *   BRAINTREE_MERCHANT_ID
 */
export class BraintreeProvider extends BaseProvider {
  private apiVersion = '2019-01-01';

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get publicKey(): string {
    return this.secrets.public_key || process.env.BRAINTREE_PUBLIC_KEY || '';
  }

  private get privateKey(): string {
    return this.secrets.private_key || process.env.BRAINTREE_PRIVATE_KEY || '';
  }

  private get merchantId(): string {
    return this.secrets.merchant_id || process.env.BRAINTREE_MERCHANT_ID || '';
  }

  private get baseUrl(): string {
    return this.config.environment === 'live'
      ? 'https://payments.braintree-api.com/graphql'
      : 'https://payments.sandbox.braintree-api.com/graphql';
  }

  public isConfigured(): boolean {
    return Boolean(this.publicKey && this.privateKey && this.merchantId);
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.publicKey}:${this.privateKey}`).toString('base64');
  }

  private async graphql(query: string, variables: Record<string, unknown>): Promise<{ data: any; errors?: any[] }> {
    const res = await this.http_request({
      method: 'POST',
      url: this.baseUrl,
      headers: {
        Authorization: this.authHeader(),
        'Braintree-Version': this.apiVersion,
      },
      body: { query, variables },
      timeoutMs: 30_000,
      maxAttempts: 2,
    });
    if (res.status >= 400 && !res.body?.errors) {
      throw new Error(`Braintree API error: HTTP ${res.status}`);
    }
    return res.body;
  }

  public async processRefund(
    providerTransactionId: string,
    amount: number,
    currency: string,
  ): Promise<RefundResult> {
    if (!this.isConfigured()) {
      return {
        status: 'success',
        refundId: 'braintree_refund_sim_' + randomUUID().replace(/-/g, '').slice(0, 16),
        amount,
        currency,
        response: { simulated: true, transactionId: providerTransactionId },
      };
    }

    try {
      const result = await this.graphql(REFUND_MUTATION, {
        input: { transactionId: providerTransactionId, refund: { amount: amount.toFixed(2) } },
      });

      if (result.errors?.length) {
        return { status: 'failed', amount, currency, error: result.errors[0]?.message || 'Braintree GraphQL error', response: result };
      }

      const refund = result.data?.refundTransaction?.refund;
      const status = refund?.status === 'SETTLED' ? 'success'
        : ['PROCESSOR_DECLINED', 'GATEWAY_REJECTED', 'FAILED', 'VOIDED'].includes(refund?.status) ? 'failed'
          : 'unknown';

      return {
        status,
        refundId: refund?.id,
        amount: refund?.amount?.value ? Number(refund.amount.value) : amount,
        currency: (refund?.amount?.currencyCode || currency).toUpperCase(),
        response: refund,
        ...(status === 'failed' ? { error: `Braintree refund status: ${refund?.status}` } : {}),
      };
    } catch (err: any) {
      return { status: 'failed', amount, currency, error: err.message };
    }
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const startTime = Date.now();

    if (!this.isConfigured() || !paymentToken) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const result = await this.graphql(CHARGE_MUTATION, {
        input: { paymentMethodId: paymentToken, transaction: { amount: amount.toFixed(2) } },
      });

      const latency = Date.now() - startTime;

      if (result.errors?.length) {
        throw new Error(result.errors[0]?.message || 'Braintree GraphQL error');
      }

      const transaction = result.data?.chargeCreditCard?.transaction;
      if (!transaction) {
        throw new Error('Braintree returned no transaction in chargeCreditCard response');
      }

      const feePercent = this.config.transactionFeePercent || 0;
      const feeFlat = this.config.transactionFeeFlat || 0;
      const cost = (amount * feePercent) / 100 + feeFlat;

      // chargeCreditCard captures funds immediately: AUTHORIZED through
      // SETTLED are all points along one successful charge's real
      // lifecycle, not distinct outcomes to guess between.
      const status =
        ['AUTHORIZED', 'SUBMITTED_FOR_SETTLEMENT', 'SETTLING', 'SETTLED'].includes(transaction.status) ? 'success'
          : ['PROCESSOR_DECLINED', 'GATEWAY_REJECTED', 'FAILED', 'VOIDED'].includes(transaction.status) ? 'failed'
            : 'unknown';

      return {
        id: transaction.id,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status,
        amount: transaction.amount?.value ? Number(transaction.amount.value) : amount,
        currency: (transaction.amount?.currencyCode || currency).toUpperCase(),
        latency,
        cost,
        decisionReason,
        payload,
        response: transaction,
        ...(status === 'failed' ? { error: `Braintree transaction status: ${transaction.status}` } : {}),
      };
    } catch (err: any) {
      const latency = Date.now() - startTime;
      return {
        id: 'err_' + randomUUID().replace(/-/g, '').slice(0, 16),
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status: 'failed',
        amount,
        currency,
        latency,
        cost: 0,
        decisionReason,
        payload,
        response: null,
        error: err.message,
      };
    }
  }

  /**
   * Simulated mode for when no credentials are configured, or the caller
   * has no tokenized payment instrument to charge.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'USD' } = payload;
    const txId = 'braintree_sim_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const feePercent = this.config.transactionFeePercent || 0;
    const feeFlat = this.config.transactionFeeFlat || 0;
    const cost = (amount * feePercent) / 100 + feeFlat;

    const responsePayload = {
      id: txId,
      status: 'SETTLED',
      amount: { value: amount.toFixed(2), currencyCode: currency.toUpperCase() },
    };

    return {
      id: txId,
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
      response: responsePayload,
    };
  }
}
