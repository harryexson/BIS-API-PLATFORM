import { randomUUID } from 'crypto';
import { BaseProvider } from '../../base';
import { ProviderConfig, TransactionEvent, PaymentRequest } from '@company/schemas';

/**
 * Authorize.Net payment provider adapter.
 *
 * Uses the Authorize.Net JSON API (https://api.authorize.net/xml/v1/request.api)
 * with createTransactionRequest / authCaptureTransaction.
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

  private get baseUrl(): string {
    const sandbox = process.env.AUTHORIZENET_SANDBOX !== 'false';
    return sandbox
      ? 'https://apitest.authorize.net/xml/v1/request.api'
      : 'https://api.authorize.net/xml/v1/request.api';
  }

  async processRequest(appId: string, payload: PaymentRequest, decisionReason: string): Promise<TransactionEvent> {
    this.verifyAvailability();

    const { amount = 10, currency = 'USD' } = payload;
    const startTime = Date.now();

    if (!this.loginId || !this.transactionKey) {
      return this.simulatedProcess(appId, payload, decisionReason);
    }

    try {
      const requestBody = {
        createTransactionRequest: {
          merchantAuthentication: {
            name: this.loginId,
            transactionKey: this.transactionKey,
          },
          refId: `bis_${Date.now()}`,
          transactionRequest: {
            transactionType: 'authCaptureTransaction',
            amount: amount.toFixed(2),
            currencyCode: currency.toUpperCase(),
            // No real card data is collected upstream of this adapter yet —
            // the sandbox test card lets this exercise the real API end-to-end.
            payment: {
              creditCard: {
                cardNumber: '4111111111111111',
                expirationDate: '2030-12',
                cardCode: '900',
              },
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
