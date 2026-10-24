import { randomUUID } from 'crypto';
import { BaseProvider, identityToUuid } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Real PawaPay mobile-money payment provider adapter.
 *
 * Uses PawaPay's v2 Merchant API (POST /v2/deposits). Facts below
 * (endpoint, auth, request/response shape, status values, error
 * envelope) were verified via web search against PawaPay's public API
 * reference on 2026-09-15 (this environment's outbound network access to
 * pawapay.io is restricted — see docs/IMPLEMENTATION_BASELINE.md §6 item
 * 1 for the same constraint on other adapters), not a live account.
 * Treat as "built from real, current documentation" rather than
 * "certified against a live sandbox."
 *
 * Unlike the card-based adapters (Stripe/NMI/Flutterwave), a mobile-money
 * deposit needs no pre-tokenized instrument — the customer authorizes it
 * on their own phone (a USSD/PIN prompt) after PawaPay receives the
 * request, using nothing more than the phone number this gateway's
 * PaymentRequest already carries. What it *does* need, which this
 * platform has no reliable way to derive on its own, is PawaPay's
 * operator+country provider code (e.g. `MTN_MOMO_RWA`, `AIRTEL_RWA`) —
 * PawaPay's own documentation directs callers to its Active Configuration
 * endpoint for this rather than inferring it from a phone number, and a
 * wrong guess would just be a different way of not doing real
 * verification. Read from `payload.metadata.pawapayProvider`; without it
 * (or without an API key) this adapter falls back to simulated
 * processing rather than guessing.
 *
 * PawaPay's deposit flow is asynchronous by nature — the synchronous
 * POST response only ever reports whether the *request* was accepted for
 * processing (`ACCEPTED`) or rejected outright (`REJECTED`); the actual
 * charge result arrives later via a callback or a separate status check,
 * neither of which this pass wires up. An ACCEPTED deposit is therefore
 * reported as this platform's 'unknown' outcome, not fabricated as a
 * success — mirroring how the routing engine treats an ambiguous
 * provider timeout.
 *
 * Environment variables:
 *   PAWAPAY_API_KEY — Bearer token
 *
 * Host (gap register E11): environment 'test' → `api.sandbox.pawapay.io`,
 * otherwise `api.pawapay.io` (pawaPay's documented sandbox/production base
 * URLs, checked via WebSearch 2026-10-23; a sandbox token only works on the
 * sandbox host).
 */
export class PawaPayProvider extends BaseProvider {
  private get baseUrl(): string {
    return this.config.environment === 'test' ? 'https://api.sandbox.pawapay.io' : 'https://api.pawapay.io';
  }

  constructor(config: ProviderConfig) {
    super(config);
  }

  private get apiKey(): string {
    return this.secrets.api_key || process.env.PAWAPAY_API_KEY || '';
  }

  // No verifyProviderWebhookSignature() override here — deliberately, not
  // an oversight. Verified via WebSearch, 2026-09-17: PawaPay signs its
  // callbacks using RFC-9421 HTTP Message Signatures — an asymmetric
  // scheme (their public key, fetched from a dedicated Public Keys
  // endpoint, not a shared secret) with its own canonicalization rules
  // for constructing the signature base from the Signature-Input
  // structured-field header. That's a materially different, larger, and
  // riskier undertaking than the HMAC-based schemes every other adapter
  // here implements (key fetching/caching, correct RFC-9421 base-string
  // construction, no live PawaPay sandbox in this environment to test
  // against) — a wrong implementation would silently degrade security
  // rather than honestly fall back, which is worse than not attempting
  // it. Inbound PawaPay webhooks fall back to the gateway's generic
  // WEBHOOK_HMAC_SECRET check (see BaseProvider's default), same as
  // before this pass — see docs/providers/ADDING_A_PROVIDER.md §6.
  public isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'KES', phoneNumber = '254700000000' } = payload;
    const provider = payload.metadata?.pawapayProvider as string | undefined;
    const startTime = Date.now();

    // No API key, or no operator+country provider code to route the
    // deposit to — either way there's no real request this adapter could
    // make without guessing at something PawaPay itself says must come
    // from its Active Configuration lookup. Fall back to simulated mode.
    if (!this.apiKey || !provider) {
      this.refuseSimulatedFallbackInProduction({
        missingCredentials: this.apiKey ? [] : ['PAWAPAY_API_KEY'],
        missingInputs: provider ? [] : ['metadata.pawapayProvider'],
      });
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    // PawaPay's `depositId` IS its idempotency key (a repeat returns
    // DUPLICATE_IGNORED) and must be a UUID, so it is a UUID derived
    // deterministically from bis_<payment_transaction_id>_<client key |
    // 'default'> (BaseProvider.identityToUuid). Previously: the raw client
    // key (not even guaranteed to be a UUID, and unscoped by app/tenant) or
    // a random UUID (gap register E7).
    const depositId = identityToUuid(this.paymentIdempotencyIdentity(payload));

    try {

      const res = await this.http_request({
        method: 'POST',
        url: `${this.baseUrl}/v2/deposits`,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: {
          depositId,
          amount: amount.toFixed(2),
          currency: currency.toUpperCase(),
          payer: {
            type: 'MMO',
            accountDetails: {
              phoneNumber: phoneNumber.replace(/^\+/, ''),
              provider,
            },
          },
        },
        timeoutMs: 30_000,
        // depositId is PawaPay's idempotency key: a repeat is answered with
        // DUPLICATE_IGNORED (mapped to 'unknown' below), never a second
        // deposit — so retrying an ambiguous attempt is safe.
        retryAmbiguous: true,
      });

      const latency = Date.now() - startTime;

      if (res.status >= 400) {
        // 4xx: the request was rejected before any deposit was initiated
        // (definite); 5xx: ambiguous (generic rule).
        throw this.httpErrorOutcome(
          res,
          res.body?.failureReason?.failureMessage || res.body?.message || `PawaPay API error: HTTP ${res.status}`,
        );
      }

      const body = res.body;
      const pawaStatus = body?.status;
      if (!pawaStatus) {
        throw this.ambiguousOutcome('PawaPay response did not include a status field', res.status);
      }

      // ACCEPTED (and the duplicate-request case, whose real outcome we
      // don't know without checking) are genuinely unresolved — the
      // customer hasn't approved or declined it yet. REJECTED is the only
      // status this synchronous response can use to report a definite
      // failure.
      const status = pawaStatus === 'REJECTED' ? 'failed' : 'unknown';

      const feePercent = this.config.transactionFeePercent || 1.0;
      const cost = status === 'unknown' ? (amount * feePercent) / 100 : 0;

      return {
        id: body.depositId || depositId,
        timestamp: new Date().toISOString(),
        appId,
        category: 'payment',
        providerId: this.config.id,
        status,
        amount,
        currency,
        latency,
        cost,
        decisionReason: status === 'unknown'
          ? `${decisionReason} | Deposit accepted for async processing — outcome must be reconciled via callback/status check, not assumed.`
          : decisionReason,
        payload,
        response: body,
        ...(status === 'failed' ? { error: body?.failureReason?.failureMessage || `PawaPay status: ${pawaStatus}` } : {}),
      };
    } catch (err: any) {
      // An ambiguous deposit keeps its deterministic depositId — PawaPay's
      // own id for it — so a later callback/status check can match it.
      return this.paymentFailureEvent({
        appId, payload, decisionReason, err, startTime, amount, currency,
        idPrefix: 'paw_err_',
        providerTransactionId: depositId,
      });
    }
  }

  /**
   * Simulated mode for when no API key or provider code is configured.
   * Used for development/testing.
   */
  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();

    const { amount = 10, currency = 'KES', phoneNumber = '254700000000' } = payload;
    const txId = 'paw-' + randomUUID().replace(/-/g, '').slice(0, 24);

    const feePercent = this.config.transactionFeePercent || 1.0;
    const cost = (amount * feePercent) / 100;

    const responsePayload = {
      depositId: txId,
      status: 'COMPLETED',
      statusTimestamp: new Date().toISOString(),
      amount: amount.toString(),
      currency: currency,
      payer: {
        type: 'MSISDN',
        address: {
          value: phoneNumber,
        },
      },
      paymentNetwork: phoneNumber.startsWith('254') ? 'SAFARICOM' : 'MTN',
      recipientDate: new Date().toISOString(),
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
