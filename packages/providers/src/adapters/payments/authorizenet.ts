import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Authorize.Net payment provider adapter.
 *
 * Uses the Authorize.Net JSON API (https://api.authorize.net/xml/v1/request.api)
 * with createTransactionRequest / authCaptureTransaction.
 *
 * The instrument is the caller's Accept.js payment nonce (`paymentToken`,
 * sent as `payment.opaqueData` with dataDescriptor
 * COMMON.ACCEPT.INAPP.PAYMENT). Previously a hardcoded sandbox test card
 * (4111...) was charged regardless of the request (gap register E8); with
 * no `paymentToken` this adapter now falls back to simulated processing
 * outside production and refuses (throws) in production.
 *
 * Idempotency: Authorize.Net has no idempotency-key mechanism. Its
 * duplicate-transaction filter (`duplicateWindow`, default 2 minutes)
 * rejects a second request with the same card, amount and invoice number
 * inside the window — so `order.invoiceNumber` (max 20 chars) is set to a
 * deterministic digest of bis_<payment_transaction_id>_<client key> (a
 * retry of the SAME payment is caught as a duplicate; two different
 * payments never share an invoice number), and `refId` (echo-only, max 20)
 * carries the same value instead of the old `bis_<Date.now()>` (E7). This
 * is a duplicate-window filter, not true idempotency — documented provider
 * limitation.
 *
 * Environment variables:
 *   AUTHORIZENET_LOGIN_ID    — API Login ID
 *   AUTHORIZENET_TRANSACTION_KEY — Transaction Key
 *   AUTHORIZENET_SANDBOX     — 'false' to use the production endpoint (defaults to sandbox)
 */
export class AuthorizeNetProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  private get loginId(): string {
    return this.secrets.login_id || process.env.AUTHORIZENET_LOGIN_ID || '';
  }

  private get transactionKey(): string {
    return this.secrets.transaction_key || process.env.AUTHORIZENET_TRANSACTION_KEY || '';
  }

  // Previously inherited BaseProvider's unconditional `true` (gap register E2).
  public isConfigured(): boolean {
    return Boolean(this.loginId && this.transactionKey);
  }

  private get baseUrl(): string {
    const sandbox = process.env.AUTHORIZENET_SANDBOX !== 'false';
    return sandbox
      ? 'https://apitest.authorize.net/xml/v1/request.api'
      : 'https://api.authorize.net/xml/v1/request.api';
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD', paymentToken } = payload;
    const startTime = Date.now();

    if (!this.loginId || !this.transactionKey || !paymentToken) {
      this.refuseSimulatedFallbackInProduction({
        missingCredentials: [
          ...(this.loginId ? [] : ['AUTHORIZENET_LOGIN_ID']),
          ...(this.transactionKey ? [] : ['AUTHORIZENET_TRANSACTION_KEY']),
        ],
        missingInputs: paymentToken ? [] : ['paymentToken'],
      });
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    // 20 chars is both refId's and invoiceNumber's documented maximum, so
    // this is always the digest form: bis_<16 hex of sha256(txid, key)>.
    const reference = this.paymentIdempotencyIdentity(payload, { maxLength: 20 });

    try {
      const requestBody = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: this.loginId,
            transactionKey: this.transactionKey,
          },
          refId: reference,
          transactionRequest: {
            transactionType: 'authCaptureTransaction',
            amount: amount.toFixed(2),
            currencyCode: currency.toUpperCase(),
            // Accept.js nonce — this gateway never handles raw card data.
            // Element order matters to Authorize.Net's schema-backed JSON
            // API: payment precedes order.
            payment: {
              opaqueData: {
                dataDescriptor: 'COMMON.ACCEPT.INAPP.PAYMENT',
                dataValue: paymentToken,
              },
            },
            order: {
              invoiceNumber: reference,
            },
          },
        },
      };

      const res = await this.http_request({
        method: 'POST',
        url: this.baseUrl,
        body: requestBody,
        timeoutMs: 30_000,
        maxAttempts: 2,
      });

      const latency = Date.now() - startTime;
      const result = res.body?.transactionResponse;
      const messageCode = res.body?.messages?.resultCode;

      if (messageCode !== 'Ok' || !result || result.responseCode !== '1') {
        const errText =
          result?.errors?.[0]?.errorText ||
          res.body?.messages?.message?.[0]?.text ||
          `Authorize.Net API error: ${res.status}`;
        throw new Error(errText);
      }

      const feePercent = this.config.transactionFeePercent || 2.9;
      const feeFlat = this.config.transactionFeeFlat || 0.30;
      const cost = (amount * feePercent) / 100 + feeFlat;

      return {
        id: result.transId,
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
        response: result,
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

  private async simulatedProcess(
    appId: string,
    payload: PaymentRequest,
    decisionReason: string,
  ): Promise<TransactionEvent> {
    const latency = await this.simulateLatency();
    const { amount = 10, currency = 'USD' } = payload;
    const transId = String(Math.floor(1_000_000_0000 + Math.random() * 8_999_999_9999));

    const feePercent = this.config.transactionFeePercent || 2.9;
    const feeFlat = this.config.transactionFeeFlat || 0.30;
    const cost = (amount * feePercent) / 100 + feeFlat;

    return {
      id: transId,
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
        transId,
        responseCode: '1',
        messages: { resultCode: 'Ok', message: [{ code: 'I00001', text: 'Successful.' }] },
        authCode: randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase(),
      },
    };
  }
}
