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
 *   AUTHORIZENET_SANDBOX     — legacy: 'false' to use the production endpoint. Only
 *                              consulted when the adapter's config carries no
 *                              environment (direct construction); a registry-
 *                              registered adapter selects its host from its
 *                              registered environment (gap register E11).
 */
/** See processRequest: transaction error codes whose outcome is not known. */
const AUTHNET_AMBIGUOUS_ERROR_CODES = new Set([
  '11', '19', '20', '21', '22', '23', '25', '26', '57', '58', '59', '60', '61', '62', '63', '120', '121', '122',
]);

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
    // E11: the registered environment is authoritative — a provider routed
    // as 'live' must call the production endpoint (it used to call the
    // sandbox unless a separate env var said otherwise, independently of
    // what the platform believed it was running as).
    const env = this.config.environment;
    const sandbox = env === 'live' ? false : env === 'test' ? true : process.env.AUTHORIZENET_SANDBOX !== 'false';
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
        // No idempotency key exists (see class comment): an attempt that may
        // have reached Authorize.Net is never re-sent. (A re-send would at
        // best be caught by the duplicate window as error 11 — which says
        // nothing about whether the FIRST one was charged.)
        retryAmbiguous: false,
      });

      const latency = Date.now() - startTime;
      const result = res.body?.transactionResponse;
      const messageCode = res.body?.messages?.resultCode;

      if (messageCode !== 'Ok' || !result || result.responseCode !== '1') {
        const errorCode = String(result?.errors?.[0]?.errorCode ?? '');
        const messageCodeId = String(res.body?.messages?.message?.[0]?.code ?? '');
        const errText =
          result?.errors?.[0]?.errorText ||
          res.body?.messages?.message?.[0]?.text ||
          `Authorize.Net API error: ${res.status}`;
        if (res.status >= 400) throw this.httpErrorOutcome(res, errText);
        if (!res.body || typeof res.body !== 'object' || (!messageCode && !result)) {
          // A 2xx we cannot interpret — the transaction may exist.
          throw this.ambiguousOutcome(`Unreadable Authorize.Net response: ${errText}`, res.status);
        }
        // transactionResponse.responseCode (Authorize.Net's documented
        // values): 1 approved, 2 declined, 3 error, 4 held for review.
        //  - 4: the transaction was AUTHORIZED and is held by the merchant's
        //    fraud filters pending review — it can still settle. Not a decline.
        //  - 3 with error 11 ("A duplicate transaction has been submitted"):
        //    an identical transaction already exists inside the duplicate
        //    window — possibly this very payment.
        //  - 3 with the "An error occurred during processing. Please try
        //    again" family (19-23, 25, 26, 57-63, 120-122 — processor
        //    communication/timeout errors) and API-level E00001 ("An error
        //    occurred during processing"): Authorize.Net could not get a
        //    definite answer from the processor.
        // All of these are ambiguous; every other decline/error is definite.
        if (
          result?.responseCode === '4' ||
          AUTHNET_AMBIGUOUS_ERROR_CODES.has(errorCode) ||
          messageCodeId === 'E00001'
        ) {
          throw this.ambiguousOutcome(
            `${errText} (responseCode ${result?.responseCode ?? 'n/a'}${errorCode ? `, errorCode ${errorCode}` : ''}${messageCodeId ? `, ${messageCodeId}` : ''}) — outcome not known`,
            res.status,
          );
        }
        throw this.definiteFailure(errText, res.status);
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
      return this.paymentFailureEvent({ appId, payload, decisionReason, err, startTime, amount, currency, idPrefix: 'err_' });
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
