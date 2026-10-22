import { randomUUID } from 'node:crypto';
import { ProviderConfig, TransactionEvent, PaymentRequest, PaymentRoutingRequest } from '@company/schemas';
import {
  ProviderRegistry,
  BaseProvider,
  isAmbiguousProviderError,
  runWithProviderCallOptions,
  type ProviderCallOptions,
} from '@company/providers';
import {
  consentRecordRepository,
  messagingProfileRepository,
  senderOptOutRepository,
  normalizeMessagingAddress,
} from '@company/database';
import { ConversationManager, ConversationContext, type ConversationSenderInfo } from './conversation';
import { findMatchingRule, type RoutingContext } from './rules';
import { computeProviderScore, rankByScore, weightedRandomSelect, type ScorableCandidate } from './scoring';
import {
  MESSAGE_CHANNELS,
  MessageChannelUnavailableError,
  addressSuitsChannel,
  effectiveChannelPolicy,
  resolveRequestedChannel,
  type EffectiveChannelPolicy,
  type MessageChannel,
} from './channel';

export { ConversationManager, type ConversationContext } from './conversation';
export {
  ConversationResolver,
  type ConversationResolution,
  type ConversationResolveInput,
  type ConversationResolverDeps,
  type ConversationOwner,
  type ResolvedConversation,
} from './conversation-resolver';
export {
  handleKeyword,
  classifyKeyword,
  matchKeywordCommand,
  buildHelpResponse,
  DEFAULT_KEYWORD_RESPONSES,
  type KeywordClass,
  type KeywordContext,
  type KeywordResult,
  type KeywordCommandConfig,
  type KeywordCommandMatch,
} from './keywords';
export { evaluateRule, findMatchingRule, type RoutingContext } from './rules';
export { computeProviderScore, rankByScore, weightedRandomSelect, type ScorableCandidate } from './scoring';

// P0: How many providers a single payment/message will cascade through
// before giving up — the initial pick plus this many additional
// score-ranked fallbacks, not unbounded (each hop can cost up to
// PROVIDER_TIMEOUT_MS, and a payment cascade stops immediately on any
// timeout regardless of this cap — see routePayment).
const MAX_ROUTING_ATTEMPTS = Number(process.env.MAX_ROUTING_ATTEMPTS) || 3;

interface RankedCandidate extends ScorableCandidate {
  name: string;
}

/**
 * Thrown when an outbound send is blocked because the recipient has
 * opted out (STOP) on this channel and hasn't opted back in (JOIN/START).
 * Distinguishable from a generic routing failure so callers (the gateway)
 * can surface a 403 instead of a retryable 503 — retrying doesn't help.
 */
/**
 * Internal options for routeMessage — a separate parameter, deliberately NOT
 * part of the payload, so nothing a tenant puts in a request body can set
 * them (the gateway calls routeMessage with two arguments only).
 */
export interface RouteMessageOptions {
  /**
   * Phase 9: this send IS the confirmation of a STOP the recipient just sent
   * (the inbound keyword pipeline's reply). Skips the tenant-level and
   * sender-level opt-out checks for this one message only. Used solely by
   * the keyword_response_delivery job for an 'opt_out' reply.
   */
  optOutConfirmation?: boolean;
}

export class ConsentBlockedError extends Error {
  constructor(recipient: string, channel: string) {
    super(`Recipient ${recipient} has opted out of ${channel} messaging (STOP) — outbound blocked.`);
    this.name = 'ConsentBlockedError';
  }
}

/**
 * P1-4 / Phase 10: Channel fallback policy — see ./channel.ts. Before Phase
 * 10 this interface and its default existed here but only
 * allowAlternateProvider was ever read: allowChannelSwitch/requiresConsent
 * were decorative, and an SMS could silently (and, via conversation
 * continuity, permanently) go out as an email (gap register A9). All three
 * are now enforced by routeMessage.
 */
export {
  DEFAULT_FALLBACK_POLICY,
  MessageChannelUnavailableError,
  InvalidMessageChannelRequestError,
  parseChannelPolicy,
  isMessageChannel,
  inferChannelFromContent,
  resolveRequestedChannel,
  addressSuitsChannel,
  channelDecisionColumns,
  MESSAGE_CHANNELS,
  type MessageChannel,
  type MessageChannelPolicy,
  type ChannelFallbackPolicy,
  type EffectiveChannelPolicy,
  type RequestedChannel,
} from './channel';

// P1: Default provider request timeout (30 seconds).
// Prevents hung provider calls from blocking the entire gateway.
export const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 30_000;

/**
 * A timeout is not a normal failure: the request may have reached the
 * provider and been processed before the response was lost. Tagging it
 * distinctly lets payment routing refuse to treat "we don't know" the same
 * as "it definitely failed" (see routePayment's catch block below).
 */
export class ProviderTimeoutError extends Error {}

/**
 * Runs one provider call under a bounded timeout that genuinely CANCELS the
 * call when it fires (gap register E6).
 *
 * The old version raced `fn()` against an `AbortSignal.timeout()` that was
 * created but never handed to the provider: the router reported 'unknown'
 * while the adapter's own http_request retry loop (up to 3 attempts with
 * backoff, ~91.5s) kept firing real charge attempts in the background that
 * nobody would ever read the result of. Now the signal is passed to
 * `fn(options)` AND installed as the ambient signal for every
 * BaseProvider.http_request made inside the call (runWithProviderCallOptions),
 * so on timeout: the in-flight fetch is aborted, any pending retry backoff
 * is interrupted, and no further request is started.
 */
async function withProviderTimeout<T>(
  fn: (options: ProviderCallOptions) => Promise<T>,
  timeoutMs: number = PROVIDER_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new ProviderTimeoutError(`Provider request timed out after ${timeoutMs}ms`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  const options: ProviderCallOptions = { signal: controller.signal };
  const call = runWithProviderCallOptions(options, () => fn(options));
  // The losing promise must never surface as an unhandled rejection.
  call.catch(() => {});
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Phase 11-12 (gap register A8, payments half): no online provider can take
 * this payment for its currency / payment method / country — the request
 * fails closed with a specific reason instead of being routed to an
 * incapable provider (the old hardcoded ['stripe','nmi','airwallex'] "global
 * fallback pool" could send an MWK mobile-money payment to Stripe as a card
 * charge).
 */
export class PaymentRouteUnavailableError extends Error {
  readonly code = 'payment_route_unavailable';
  /** Nothing was sent to any provider. */
  readonly ambiguous = false;
  constructor(readonly detail: string) {
    super(`Payment routing failure: ${detail}`);
    this.name = 'PaymentRouteUnavailableError';
  }
}

/**
 * Phase 11-12 (A8): the caller explicitly named a provider (providerOverride)
 * that is online but cannot handle this payment's currency / payment method /
 * country. Rejected rather than either charging through it or silently
 * substituting another provider — see routePayment for the reasoning.
 */
export class PaymentOverrideIncapableError extends Error {
  readonly code = 'provider_override_incapable';
  readonly ambiguous = false;
  constructor(readonly providerId: string, readonly detail: string) {
    super(`Provider override '${providerId}' cannot process this payment: ${detail}`);
    this.name = 'PaymentOverrideIncapableError';
  }
}

/**
 * Phase 15 (gap register A14a): the provider's circuit is HALF_OPEN with its
 * single recovery probe already in flight (or it re-opened since it was
 * selected) — this request was NOT sent to it. Definite, so payment and
 * messaging cascades move on to the next candidate, and it is never
 * recorded as a provider failure.
 */
export class ProviderCircuitOpenError extends Error {
  readonly code = 'provider_circuit_open';
  readonly ambiguous = false;
  constructor(readonly providerId: string) {
    super(`Provider '${providerId}' is not accepting traffic right now (circuit breaker recovery probe in flight) — not sent.`);
    this.name = 'ProviderCircuitOpenError';
  }
}

/** Phase 8: the sender-level STOP lookup failed — the send is aborted, never cascaded. */
class SenderConsentLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SenderConsentLookupError';
  }
}

/**
 * Phase 8: ISO country for an E.164 number, ONLY for calling codes that map
 * to exactly one country (NANP '+1' is shared by US/CA/... and is left
 * undetermined). Used solely as a tie-breaker between an owner's own
 * per-country sender registrations — never for anything tenant-related.
 */
const SINGLE_COUNTRY_CALLING_CODES: Record<string, string> = {
  '265': 'MW', '260': 'ZM', '263': 'ZW', '258': 'MZ', '255': 'TZ', '254': 'KE', '256': 'UG',
  '250': 'RW', '257': 'BI', '251': 'ET', '27': 'ZA', '234': 'NG', '233': 'GH', '221': 'SN',
  '225': 'CI', '237': 'CM', '243': 'CD', '244': 'AO', '267': 'BW', '264': 'NA', '266': 'LS',
  '268': 'SZ', '44': 'GB', '353': 'IE', '61': 'AU', '64': 'NZ', '91': 'IN', '49': 'DE', '33': 'FR',
};

export function countryForE164(raw: string): string | undefined {
  const n = normalizeMessagingAddress(raw);
  if (!n.startsWith('+')) return undefined;
  const digits = n.slice(1);
  for (const len of [3, 2]) {
    const code = digits.slice(0, len);
    if (SINGLE_COUNTRY_CALLING_CODES[code]) return SINGLE_COUNTRY_CALLING_CODES[code];
  }
  return undefined;
}

export class RoutingEngine {
  private registry: ProviderRegistry;
  private conversationManager: ConversationManager;

  constructor() {
    this.registry = ProviderRegistry.getInstance();
    this.conversationManager = new ConversationManager();
  }

  /**
   * Phase 15 (gap register A14a/A14d): the ONE place a provider is actually
   * called, so the circuit breaker sees every real attempt — including each
   * one that failed earlier in a failover cascade. (Previously only the
   * gateway's observe() of the FINAL event recorded anything: a provider
   * that failed mid-cascade never had a failure recorded, a thrown routing
   * failure was charged to `providerOverride || 'failed_route'` instead of
   * the provider that failed, and worker-dispatched calls were never
   * recorded at all.)
   *
   *  - The dispatch is claimed first (tryAcquireDispatch): this is what
   *    admits exactly one HALF_OPEN recovery probe. A refused claim throws
   *    ProviderCircuitOpenError — nothing was sent.
   *  - Outcome recorded: an event counts as a success only if
   *    status === 'success' (unchanged from observe()'s classification); a
   *    timeout or an ambiguous thrown error is a failure. A DEFINITE thrown
   *    error (nothing was sent: missing input, not configured, ...) says
   *    nothing about the provider's health — not recorded, and a probe
   *    slot is handed back (releaseDispatch).
   */
  private async dispatch(
    provider: BaseProvider,
    call: (options: ProviderCallOptions) => Promise<TransactionEvent>,
  ): Promise<TransactionEvent> {
    const id = provider.config.id;
    if (!this.registry.tryAcquireDispatch(id)) throw new ProviderCircuitOpenError(id);
    let event: TransactionEvent;
    try {
      event = await withProviderTimeout(call);
    } catch (err) {
      if (err instanceof ProviderTimeoutError) {
        this.registry.recordTraffic(id, false, PROVIDER_TIMEOUT_MS);
      } else if (isAmbiguousProviderError(err)) {
        this.registry.recordTraffic(id, false, 0);
      } else {
        this.registry.releaseDispatch(id);
      }
      throw err;
    }
    this.registry.recordTraffic(id, event.status === 'success', event.latency ?? 0);
    return event;
  }

  // Capability-based payment routing — selects providers by capabilities/currency
  // rather than hardcoded provider IDs. Adding a new provider with the right
  // capabilities automatically makes it eligible for routing.
  //
  // Selection precedence: (1) an explicit providerOverride from the caller,
  // (2) an admin-configured routing rule whose match expression holds (see
  // packages/routing/src/rules.ts — this data has existed with full CRUD
  // and an admin console UI since an earlier pass, but was never actually
  // consulted here; every rule an admin created was purely decorative
  // until this pass), (3) success-rate/cost-scored selection among
  // capability-matched candidates (packages/routing/src/scoring.ts — real
  // signals: ProviderRegistry.recordTraffic's live rolling error rate and
  // the admin-configured transactionFeePercent/Flat, not just the static
  // weight the previous version used alone).
  //
  // On failure, cascades through the remaining score-ranked candidates
  // (up to MAX_ROUTING_ATTEMPTS total attempts) rather than the single
  // fixed fallback hop the previous version made — except a timeout,
  // which stops the cascade immediately at any point in the chain: the
  // provider may have already processed the charge, so retrying it
  // through another provider risks a real double charge on an outcome
  // that isn't actually known to have failed.
  //
  // Every field of the request — including paymentToken, country, metadata,
  // idempotencyKey and the platform's paymentTransactionId — is forwarded
  // unchanged to whichever adapter(s) are tried (gap register C1/E1/C11).
  // The SAME paymentTransactionId goes to every provider in a failover
  // cascade: each provider's idempotency namespace is its own, and the
  // platform transaction row being attempted is one and the same.
  public async routePayment(appId: string, request: PaymentRoutingRequest): Promise<TransactionEvent> {
    const event = await this.routePaymentAttempts(appId, request);
    return request.paymentTransactionId && !event.paymentTransactionId
      ? { ...event, paymentTransactionId: request.paymentTransactionId }
      : event;
  }

  private async routePaymentAttempts(appId: string, request: PaymentRoutingRequest): Promise<TransactionEvent> {
    // Adapters apply their own currency/paymentMethod defaults; the cast
    // reflects that PaymentRequest's required fields may be defaulted.
    const payload = request as PaymentRequest & { providerOverride?: string };
    const { currency = 'USD', paymentMethod = 'card', providerOverride, country } = request;
    const amount = Number(payload.amount);
    let selectedProvider: BaseProvider | null = null;
    let reason = '';

    const allProviders = this.registry.getAllConfigs();
    const activePayments = allProviders.filter(
      p => p.category === 'payment' && this.registry.isProviderAvailable(p.id) && this.registry.isLiveEligible(p.id),
    );

    if (activePayments.length === 0) {
      throw new Error('All payment providers are currently OFFLINE / UNDER MAINTENANCE');
    }

    // The capable pool: every online, production-eligible payment provider
    // that supports this payment's capability, currency AND country
    // (registry.findByCategoryAndCapabilities — the one place that logic
    // lives). Phase 11-12 (gap register A8, payments half): EVERY selection
    // path — override, routing rule, scored pick, and the failover cascade —
    // now only ever picks from this pool. Previously the override and
    // rule-target paths checked only availability/live-eligibility, and an
    // empty pool fell back to a hardcoded ['stripe','nmi','airwallex'] pool,
    // so e.g. an MWK mobile-money payment could be sent to Stripe as a card
    // charge.
    const cur = currency.toUpperCase();
    const countryCode = country ? String(country).toUpperCase() : undefined;
    const capabilities = [paymentMethod];
    if (paymentMethod === 'mobile_money') capabilities.push('mobile_money');
    const candidatePool: RankedCandidate[] = this.registry.findByCategoryAndCapabilities('payment', capabilities, cur, countryCode);
    const capableIds = new Set(candidatePool.map((c) => c.id));
    const requirement = `${cur}/${paymentMethod}${countryCode ? `/${countryCode}` : ''}`;
    const usable = (id: string) => this.registry.isProviderAvailable(id) && this.registry.isLiveEligible(id);

    // 1. Manual override.
    //
    // Design decision (Phase 11-12): an explicit providerOverride does NOT
    // bypass the capability/currency/country checks, and an override that is
    // online but incapable is REJECTED (PaymentOverrideIncapableError), not
    // silently swapped for another provider:
    //  - providerOverride is a field of the tenant's API request, not
    //    operator configuration. Country/currency enablement is also where
    //    compliance restrictions live (a provider not licensed/enabled for a
    //    country), and a request body must not be able to route around them.
    //  - a caller that names a provider almost always holds a
    //    provider-specific instrument (paymentToken is a Stripe pm_..., an
    //    Adyen storedPaymentMethodId, ...). Charging it through a DIFFERENT
    //    provider cannot be what the caller meant, and charging it through
    //    the named-but-incapable provider (wrong currency/country/method)
    //    can only fail or settle wrongly. A specific error the caller can
    //    fix beats both.
    //  - an override that is merely offline/unavailable keeps its existing,
    //    tested behaviour (fall back to the capable pool), because that is a
    //    transient condition rather than a request that can never succeed.
    if (providerOverride) {
      const provider = this.registry.getProvider(providerOverride);
      if (!provider || !usable(providerOverride)) {
        reason = `Manual override '${providerOverride}' requested but provider is offline/invalid/not production-eligible. Falling back. | `;
      } else if (!capableIds.has(providerOverride)) {
        throw new PaymentOverrideIncapableError(
          providerOverride,
          this.paymentCapabilityGap(providerOverride, capabilities, cur, countryCode) ?? `not eligible for ${requirement}`,
        );
      } else {
        selectedProvider = provider;
        reason = `Manual override matched: Forced routing to '${provider.config.name}'.`;
      }
    }

    // 2. Admin-configured routing rule — its target is used only if it is in
    // the capable pool. A rule is a broad admin policy ("amount > 100 →
    // adyen"); a target that cannot take THIS payment simply does not apply
    // to it (recorded in decisionReason), and routing continues with the
    // capable pool.
    if (!selectedProvider) {
      const ctx: RoutingContext = { currency: cur, amount, paymentMethod, country: countryCode };
      const rule = findMatchingRule(this.registry.getEnabledRoutingRules(), ctx);
      if (rule) {
        const provider = this.registry.getProvider(rule.target);
        if (!provider || !usable(rule.target)) {
          reason += `Routing rule matched ('${rule.match}') but target '${rule.target}' is offline/invalid. Falling back. | `;
        } else if (!capableIds.has(rule.target)) {
          reason += `Routing rule matched ('${rule.match}') but target '${rule.target}' cannot process ${requirement} (${this.paymentCapabilityGap(rule.target, capabilities, cur, countryCode) ?? 'not eligible'}) — rule not applied. Falling back. | `;
        } else {
          selectedProvider = provider;
          reason += `Routing rule matched ('${rule.match}'${rule.description ? ` — ${rule.description}` : ''}): routed to '${provider.config.name}'.`;
        }
      }
    }

    // 3. No capable provider at all: fail closed (never an incapable one).
    if (candidatePool.length === 0) {
      throw new PaymentRouteUnavailableError(
        `no online, production-eligible payment provider supports ${requirement} ` +
          `(capability ${capabilities.join('+')}, currency ${cur}${countryCode ? `, country ${countryCode}` : ''}). ` +
          'The payment was NOT sent to any provider.',
      );
    }

    // 4. Success-rate/cost-scored pick among the capable pool — also the
    // basis for the cascading fallback order below.
    const ranked = rankByScore(candidatePool, { amount });
    const poolDescription = `capability match for ${requirement}`;

    if (!selectedProvider && ranked.length > 0) {
      const chosen = weightedRandomSelect(ranked, c => computeProviderScore(c, { amount }));
      const provider = this.registry.getProvider(chosen.id);
      if (provider) {
        selectedProvider = provider;
        reason += `Success-rate/cost-scored routing (${poolDescription}): candidates [${ranked.map(c => c.name).join(', ')}]. Selected '${chosen.name}' (error rate ${(chosen.errorRate ?? 0).toFixed(1)}%).`;
      }
    }

    if (!selectedProvider) {
      throw new PaymentRouteUnavailableError(`no capable provider for ${requirement} could be instantiated.`);
    }

    const fallbackOrder = ranked.filter(c => c.id !== selectedProvider!.config.id);
    const attemptedIds = new Set<string>();
    let currentProvider = selectedProvider;
    let currentReason = reason;

    for (let attempt = 1; ; attempt++) {
      attemptedIds.add(currentProvider.config.id);

      // A soft decline (the provider call succeeded and returned a
      // definite 'failed' TransactionEvent — a real decline, not an
      // infrastructure failure) is safe to retry via another
      // provider/acquirer: the charge is known NOT to have moved money.
      //
      // Phase 11-12 (gap register A10/E4/PHASE3-01): that is now the ONLY
      // kind of outcome that cascades. Every adapter classifies its own
      // failures — network error / timeout / 5xx / unreadable answer →
      // 'unknown', a genuine decline → 'failed' (see BaseProvider's
      // ProviderCallError) — and the router never retries an 'unknown'. A
      // THROWN error cascades only if it is explicitly classified definite
      // (ambiguous === false: provider offline, not configured, missing
      // input — nothing was sent). An unclassified thrown error is treated
      // as ambiguous: the router cannot know whether the adapter had already
      // sent the charge, so "we don't know" is the only honest answer.
      let event: TransactionEvent | undefined;
      let declineMessage: string | undefined;
      try {
        // Bounded, and genuinely cancelling: on timeout the adapter's
        // in-flight request and any internal retries are aborted (E6).
        event = await this.dispatch(currentProvider, (options) => currentProvider!.processRequest(appId, payload, currentReason, options));
      } catch (err: any) {
        if (err instanceof ProviderTimeoutError || isAmbiguousProviderError(err)) {
          // Phase 6 (gap register D4): the provider's own id was never
          // received, so there is none to report. The event's id is the
          // platform's own pre-allocated, stable payment transaction id —
          // NOT a throwaway randomUUID() (which used to be stored as the
          // row's provider_transaction_id, where no later provider webhook
          // or status check could ever match it). The gateway stores
          // provider_transaction_id = NULL for this case (see
          // paymentOutcomeFromEvent in @company/database) and the row in the
          // distinct 'unknown' status. Only a caller that allocated no row
          // gets a clearly-labelled placeholder.
          const timedOut = err instanceof ProviderTimeoutError;
          return {
            id: request.paymentTransactionId || `unknown_${randomUUID()}`,
            timestamp: new Date().toISOString(),
            appId,
            category: 'payment',
            providerId: currentProvider.config.id,
            status: 'unknown',
            amount,
            currency,
            latency: timedOut ? PROVIDER_TIMEOUT_MS : 0,
            cost: 0,
            decisionReason: `${currentReason} | Ambiguous outcome: ${err?.message ?? err}. Not retried via another provider — outcome must be reconciled via webhook/status check before any further action.`,
            payload,
            response: null,
            error: err?.message ?? String(err),
          };
        }
        declineMessage = err.message;
      }

      // 'success', 'pending' or the genuinely ambiguous 'unknown' all return
      // immediately — 'unknown' must never be retried via another provider
      // for the same double-charge-risk reason a timeout isn't.
      if (event && event.status !== 'failed') {
        return event;
      }
      if (event) declineMessage = event.error || `provider reported status '${event.status}'`;

      const next = fallbackOrder.find(c => !attemptedIds.has(c.id));
      if (!next || attempt >= MAX_ROUTING_ATTEMPTS) {
        // The cascade is exhausted. If the last attempt resolved with a
        // real (if declined) result, that IS the honest outcome to
        // return — not a thrown error masking a transaction that
        // actually completed (as declined) on every provider tried.
        if (event) return event;
        throw new Error(
          `Payment routing exhausted after ${attempt} attempt(s) [${Array.from(attemptedIds).join(' -> ')}]: last failure on '${currentProvider.config.name}' (${declineMessage}).`,
        );
      }
      const nextProvider = this.registry.getProvider(next.id)!;
      const verb = event ? 'declined' : 'failed';
      currentReason = `Dynamic Failover (cascading, attempt ${attempt + 1}/${Math.min(MAX_ROUTING_ATTEMPTS, fallbackOrder.length + 1)}): '${currentProvider.config.name}' ${verb} (${declineMessage}). Trying next-best-ranked '${nextProvider.config.name}'. | ${currentReason}`;
      currentProvider = nextProvider;
    }
  }

  /** Why a payment provider is not in the capable pool (null = it is capable). */
  private paymentCapabilityGap(providerId: string, capabilities: string[], currency: string, country?: string): string | null {
    const view = this.registry.getManagementView(providerId);
    if (!view || view.category !== 'payment') return `'${providerId}' is not a payment provider`;
    const missing = capabilities.filter((c) => !view.capabilities.includes(c));
    if (missing.length > 0) {
      return `does not support payment method '${missing.join("', '")}' (supports: ${view.capabilities.join(', ') || 'none'})`;
    }
    if (!view.currencies.includes(currency) && !view.currencies.includes('*')) {
      return `does not support currency ${currency} (supports: ${view.currencies.join(', ') || 'none'})`;
    }
    if (country && !view.countries.includes(country) && !view.countries.includes('*')) {
      return `is not enabled for country ${country} (enabled: ${view.countries.join(', ') || 'none'})`;
    }
    return null;
  }

  // Capability-based messaging routing. Same precedence model as
  // routePayment above, with one addition ahead of everything except an
  // explicit providerOverride: conversation continuity (reusing the
  // provider an ongoing thread already used) — a routing rule or a
  // score-based pick must never silently switch providers mid-conversation.
  //
  // Phase 10 (gap register A6/A8/A9) — the CHANNEL is never changed
  // silently:
  //  - the requested channel is the caller's explicit `channel`, or (only
  //    when absent) the legacy content-inferred default — see ./channel.ts;
  //  - every step (override, continuity, rule target, scored pool, failover
  //    cascade) only ever considers providers that declare the requested
  //    channel's capability. The old last-resort pool — "any active
  //    messaging provider", which is how an SMS used to become an email —
  //    is gone;
  //  - when no provider of the requested channel can take the message, the
  //    send FAILS (MessageChannelUnavailableError, with a specific reason)
  //    unless the caller opted in for this message via
  //    channelPolicy.allowChannelSwitch === true, in which case the opted-in
  //    fallback channels are tried — each one only with a usable address
  //    and the recipient's affirmative consent on it (requiresConsent);
  //  - every event carries requestedChannel / requestedChannelSource /
  //    selectedChannel / fallbackReason (null unless the channel differs);
  //  - a fallback is per-message, never sticky: the next message starts
  //    again from its own requested channel, and continuity only reuses a
  //    thread on that same channel.
  public async routeMessage(appId: string, payload: any, options: RouteMessageOptions = {}): Promise<TransactionEvent> {
    const { recipient = '', content = '', providerOverride, tenantId = 'default' } = payload;
    // Phase 8: the gateway's VERIFIED supplier scope (never a body field —
    // resolveTenantContext strips those). Part of the conversation owner key.
    const supplierId: string | null = typeof payload.supplierId === 'string' && payload.supplierId ? payload.supplierId : null;

    // Determined once, reused for consent checking, capability routing, and
    // conversation recording. EXPLICIT request first; the content heuristic
    // only as the backward-compatible default (see resolveRequestedChannel).
    const requested = resolveRequestedChannel({
      explicit: payload.channel,
      recipient,
      content,
      overrideId: typeof providerOverride === 'string' ? providerOverride : undefined,
      overrideChannels: typeof providerOverride === 'string' ? this.channelsOf(providerOverride) : undefined,
    });
    const requestedChannel = requested.channel;
    const policy = effectiveChannelPolicy(payload.channelPolicy, requestedChannel);
    const stamp = (event: TransactionEvent, selectedChannel: MessageChannel, fallbackReason: string | null): TransactionEvent => ({
      ...event,
      requestedChannel,
      requestedChannelSource: requested.source,
      selectedChannel,
      fallbackReason,
    });

    // Consent: a STOP keyword blocks non-permitted outbound messaging on
    // this channel until the recipient opts back in (JOIN/START/HELP).
    // Fails open (allows the send) on a consent-store lookup error,
    // consistent with ConversationManager's existing best-effort pattern
    // in this same routing layer — a DB hiccup shouldn't take down all
    // outbound messaging. This is a real tradeoff (a genuinely opted-out
    // recipient could receive a message during a DB outage) surfaced via
    // console.error rather than swallowed silently; hardening it to
    // fail-closed is a documented follow-up (gap register A7), not done here.
    // Phase 9: the ONE message a recipient may receive after opting out is
    // the confirmation of that opt-out (CTIA). Internal-only option, never
    // reachable from a request body (see RouteMessageOptions).
    const optOutConfirmation = options.optOutConfirmation === true;
    let optedOut = false;
    if (recipient && !optOutConfirmation) {
      try {
        optedOut = await consentRecordRepository.isOptedOut(appId, tenantId, recipient, requestedChannel);
      } catch (err: any) {
        console.error(`[routing] consent lookup failed for ${recipient} — failing open (send proceeds): ${err.message}`);
      }
    }
    if (optedOut) {
      throw new ConsentBlockedError(recipient, requestedChannel);
    }

    const activeMsg = this.registry.getAllConfigs().filter(
      p => p.category === 'messaging' && this.registry.isProviderAvailable(p.id) && this.registry.isLiveEligible(p.id),
    );
    if (activeMsg.length === 0) {
      throw new MessageChannelUnavailableError(
        requestedChannel,
        requested.source,
        'All messaging providers are currently OFFLINE / UNDER MAINTENANCE (no online, production-eligible messaging provider on any channel).',
      );
    }

    // 1. The requested channel.
    const primary = await this.sendOnChannel({
      appId, payload, tenantId, supplierId, optOutConfirmation, policy,
      channel: requestedChannel,
      address: recipient,
      providerOverride: typeof providerOverride === 'string' && providerOverride ? providerOverride : undefined,
      reasonPrefix: `${requested.note} | `,
    });
    if (primary.kind === 'sent') return stamp(primary.event, requestedChannel, null);

    if (!policy.allowChannelSwitch) {
      throw new MessageChannelUnavailableError(
        requestedChannel,
        requested.source,
        `${primary.reason}. Channel switching is not permitted for this message (channelPolicy.allowChannelSwitch is not true), so it was NOT sent on any other channel.`,
      );
    }

    // 2. Opted-in channel switch: each fallback channel in the caller's
    // order, each re-checked for an address, consent, and its own providers.
    const skipped: string[] = [];
    for (const channel of policy.fallbackChannels) {
      const address = policy.fallbackRecipients[channel] ?? (addressSuitsChannel(recipient, channel) ? recipient : undefined);
      if (!address) {
        skipped.push(`'${channel}' skipped: no ${channel} address for this recipient (channelPolicy.fallbackRecipients.${channel} not provided)`);
        continue;
      }
      const consent = await this.fallbackConsent(appId, tenantId, address, channel, policy);
      if (!consent.ok) {
        skipped.push(`'${channel}' skipped: ${consent.reason}`);
        continue;
      }
      let attempt: Awaited<ReturnType<RoutingEngine['sendOnChannel']>>;
      try {
        attempt = await this.sendOnChannel({
          appId, payload, tenantId, supplierId, optOutConfirmation, policy,
          channel,
          address,
          providerOverride: undefined, // an override names a provider for the REQUESTED channel only
          reasonPrefix: `${requested.note} | Channel switch ${requestedChannel} -> ${channel} (caller opted in): ${primary.reason}. | `,
        });
      } catch (err) {
        // A number-level STOP on a fallback channel only rules out THAT
        // channel; a failed sender-consent lookup still aborts everything.
        if (err instanceof ConsentBlockedError) {
          skipped.push(`'${channel}' skipped: recipient ${address} has opted out of ${channel} on the sending number`);
          continue;
        }
        throw err;
      }
      if (attempt.kind === 'sent') {
        const fallbackReason =
          `Requested channel '${requestedChannel}' unavailable: ${primary.reason}. ` +
          `Sent on fallback channel '${channel}' to ${address} because the caller opted in to channel switching for this message (channelPolicy.allowChannelSwitch=true)` +
          (skipped.length > 0 ? `; earlier fallback channels: ${skipped.join('; ')}` : '') +
          '.';
        return stamp(attempt.event, channel, fallbackReason);
      }
      skipped.push(`'${channel}' failed: ${attempt.reason}`);
    }

    throw new MessageChannelUnavailableError(
      requestedChannel,
      requested.source,
      `${primary.reason}. Channel switching was permitted, but no fallback channel delivered it: ${skipped.length > 0 ? skipped.join('; ') : 'no fallback channels to try'}.`,
    );
  }

  /** Messaging channels a provider declares (its capabilities ∩ MESSAGE_CHANNELS). */
  private channelsOf(providerId: string): MessageChannel[] {
    const view = this.registry.getManagementView(providerId);
    if (!view || view.category !== 'messaging') return [];
    return MESSAGE_CHANNELS.filter((c) => view.capabilities.includes(c));
  }

  private supportsChannel(providerId: string, channel: MessageChannel): boolean {
    return this.channelsOf(providerId).includes(channel);
  }

  /**
   * requiresConsent (Phase 10): a channel the recipient was NOT asked to be
   * contacted on is used only with their affirmative consent on it — an
   * 'opted_in' record for that address and channel — and never past an
   * opt-out. A lookup error rules the channel out (fail closed): a channel
   * switch is an exception path, never worth guessing consent for.
   */
  private async fallbackConsent(
    appId: string,
    tenantId: string,
    address: string,
    channel: MessageChannel,
    policy: EffectiveChannelPolicy,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    let status: string | undefined;
    try {
      status = (await consentRecordRepository.findByRecipient(appId, tenantId, address, channel))?.status;
    } catch (err: any) {
      return { ok: false, reason: `consent lookup for ${address} on ${channel} failed (${err?.message ?? err}) — not switching channel without it` };
    }
    if (status === 'opted_out') return { ok: false, reason: `recipient ${address} has opted out of ${channel}` };
    if (policy.requiresConsent && status !== 'opted_in') {
      return { ok: false, reason: `recipient ${address} has no recorded opt-in for ${channel} (channel switching requires the recipient's consent on the fallback channel)` };
    }
    return { ok: true };
  }

  /**
   * One channel's provider selection + same-channel failover cascade. Only
   * providers declaring `channel` are ever considered. Returns 'unavailable'
   * with a SPECIFIC reason (never a generic one) when nothing on this
   * channel took the message; throws only for consent conditions, which are
   * never routed around.
   */
  private async sendOnChannel(args: {
    appId: string;
    payload: any;
    tenantId: string;
    supplierId: string | null;
    optOutConfirmation: boolean;
    policy: EffectiveChannelPolicy;
    channel: MessageChannel;
    address: string;
    providerOverride?: string;
    reasonPrefix: string;
  }): Promise<{ kind: 'sent'; event: TransactionEvent } | { kind: 'unavailable'; reason: string }> {
    const { appId, tenantId, supplierId, optOutConfirmation, policy, channel, address, providerOverride } = args;
    const usable = (id: string) => this.registry.isProviderAvailable(id) && this.registry.isLiveEligible(id);
    const notes: string[] = [];
    let selectedProvider: BaseProvider | null = null;
    let reason = args.reasonPrefix;

    const conversationCtx: ConversationContext = { phoneNumber: address, appId, tenantId, supplierId };

    // 1. Manual override check — honoured only for a provider that can
    // actually send on this channel.
    if (providerOverride) {
      const provider = this.registry.getProvider(providerOverride);
      if (!provider || !usable(providerOverride)) {
        reason += `Override '${providerOverride}' unavailable or not production-eligible. Falling back. | `;
        notes.push(`requested provider '${providerOverride}' is offline/unavailable or not production-eligible`);
      } else if (!this.supportsChannel(providerOverride, channel)) {
        reason += `Override '${providerOverride}' does not support the '${channel}' channel — not used. Falling back. | `;
        notes.push(`requested provider '${providerOverride}' does not support ${channel}`);
      } else {
        selectedProvider = provider;
        reason += `Manual override matched: Forced messaging route to '${provider.config.name}'.`;
      }
    }

    // 2. Conversation continuity — this owner's thread ON THIS CHANNEL only
    // (Phase 10: a thread on a fallback channel never captures later sends).
    // An explicit providerOverride takes priority (even an unusable one
    // skips continuity, as before).
    if (!selectedProvider && !providerOverride) {
      const conversation = await this.conversationManager.resolve(conversationCtx, channel);
      if (conversation) {
        const provider = this.registry.getProvider(conversation.providerId);
        if (provider && usable(conversation.providerId) && this.supportsChannel(conversation.providerId, channel)) {
          selectedProvider = provider;
          reason += `Conversation continuity: Reusing ${channel} provider '${provider.config.name}' for ${address}.`;
        } else {
          reason += `Conversation continuity: previous ${channel} provider '${conversation.providerId}' is unavailable. | `;
        }
      }
    }

    // 3. Admin-configured routing rule (never overrides conversation
    // continuity above — see routeMessage's comment). Its target must
    // support this channel.
    if (!selectedProvider) {
      const ctx: RoutingContext = { channel };
      const rule = findMatchingRule(this.registry.getEnabledRoutingRules(), ctx);
      if (rule) {
        const provider = this.registry.getProvider(rule.target);
        if (provider && usable(rule.target) && this.supportsChannel(rule.target, channel)) {
          selectedProvider = provider;
          reason += `Routing rule matched ('${rule.match}'${rule.description ? ` — ${rule.description}` : ''}): routed to '${provider.config.name}'.`;
        } else {
          reason += `Routing rule matched ('${rule.match}') but target '${rule.target}' is offline/invalid or does not support ${channel}. Falling back. | `;
        }
      }
    }

    // 4. Success-rate/cost-scored capability routing — this channel's
    // capability only. Same-channel failover is what
    // policy.allowAlternateProvider governs.
    const ranked: RankedCandidate[] = rankByScore(
      this.registry.findByCategoryAndCapabilities('messaging', [channel]),
    );

    if (!selectedProvider && ranked.length > 0) {
      const chosen = weightedRandomSelect(ranked, (c) => computeProviderScore(c));
      const provider = this.registry.getProvider(chosen.id);
      if (provider) {
        selectedProvider = provider;
        reason += `${channel} routing: candidates [${ranked.map(c => c.name).join(', ')}]. Selected '${chosen.name}' (error rate ${(chosen.errorRate ?? 0).toFixed(1)}%).`;
      }
    }

    // Phase 10 (gap register A8): there is NO "any available messaging
    // provider" last resort any more — that pool is exactly how an SMS used
    // to be handed to the email provider.
    if (!selectedProvider) {
      return {
        kind: 'unavailable',
        reason: `no online, production-eligible ${channel}-capable messaging provider is available${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
      };
    }

    // Cascading waterfall across same-channel candidates, best-first by
    // score, up to MAX_ROUTING_ATTEMPTS total attempts. Unlike payments, a
    // messaging timeout is not treated as an ambiguous outcome worth
    // stopping the cascade for — resending a message carries none of a
    // duplicate-charge's real-money risk.
    const fallbackOrder = policy.allowAlternateProvider ? ranked.filter(c => c.id !== selectedProvider!.config.id) : [];
    const attemptedIds = new Set<string>();
    const failures: string[] = [];
    let currentProvider = selectedProvider;
    let currentReason = reason;
    // What the adapter is told to send: the address on THIS channel, and the
    // channel itself (Twilio, for one, chooses SMS vs WhatsApp from it).
    const sendPayload = { ...args.payload, recipient: address, channel };

    for (let attempt = 1; ; attempt++) {
      attemptedIds.add(currentProvider.config.id);
      try {
        // Phase 8: which business number this provider will send FROM, and
        // whether the recipient has opted out of that NUMBER (a STOP on a
        // shared number — see sender_opt_outs). Fails CLOSED: a lookup
        // error aborts the whole send (no cascade to another provider),
        // never a send past a possible STOP.
        const sender = await this.senderFor(appId, tenantId, supplierId, currentProvider, address);
        let senderOptedOut = false;
        if (sender.businessNumber && address && !optOutConfirmation) {
          try {
            senderOptedOut = await senderOptOutRepository.isOptedOut(sender.businessNumber, address, channel);
          } catch (lookupErr: any) {
            throw new SenderConsentLookupError(`sender-level consent lookup failed for ${sender.businessNumber}: ${lookupErr?.message}`);
          }
        }
        if (senderOptedOut) {
          // A STOP is not a provider failure: never cascade AROUND it to
          // another provider/number automatically. (A caller that genuinely
          // owns a different number may still send from it explicitly via
          // providerOverride.)
          throw new ConsentBlockedError(address, channel);
        }
        // P1: Wrap provider call with timeout to prevent hung requests
        const event = await this.dispatch(currentProvider, (options) => currentProvider!.processRequest(appId, sendPayload, currentReason, options));
        // P2-8: Record conversation after successful delivery — on the
        // business number it was sent from (Phase 8), on the channel it was
        // actually sent on (Phase 10).
        await this.conversationManager.record(conversationCtx, currentProvider.config.id, channel, sender);
        return { kind: 'sent', event };
      } catch (err: any) {
        if (err instanceof ConsentBlockedError || err instanceof SenderConsentLookupError) throw err;
        failures.push(`'${currentProvider.config.name}' failed (${err.message})`);
        const next = fallbackOrder.find(c => !attemptedIds.has(c.id));
        if (!next || attempt >= MAX_ROUTING_ATTEMPTS) {
          const why = !next
            ? (policy.allowAlternateProvider ? `no other ${channel}-capable provider available` : 'alternate-provider failover disabled')
            : `stopped after MAX_ROUTING_ATTEMPTS=${MAX_ROUTING_ATTEMPTS}`;
          return {
            kind: 'unavailable',
            reason: `Messaging dispatch failed on every ${channel} provider tried — ${failures.join('; ')} — ${why}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
          };
        }
        const nextProvider = this.registry.getProvider(next.id)!;
        currentReason = `Dynamic Failover (cascading, attempt ${attempt + 1}): '${currentProvider.config.name}' failed (${err.message}). Switched to '${nextProvider.config.name}'. | ${currentReason}`;
        currentProvider = nextProvider;
      }
    }
  }

  /**
   * Phase 8: the business number an outbound send through `provider` goes
   * FROM, for recording on the conversation and for the sender-level STOP
   * check.
   *
   *  1. The adapter's own account-level sender (TWILIO_FROM_NUMBER etc.) is
   *     the truth when known — it is the number the provider actually uses
   *     (and, on a shared number, the same for every tenant). The owner's
   *     messaging profile for that sender, if any, is linked.
   *  2. Otherwise, the owner's registration for this provider: a profile
   *     dedicated to the sending supplier first, then a tenant-level one —
   *     used only when exactly one matches (several registrations, e.g. one
   *     per country, with no way to tell which the adapter will use, means
   *     the number is honestly left unrecorded rather than guessed).
   */
  private async senderFor(
    appId: string,
    tenantId: string,
    supplierId: string | null,
    provider: BaseProvider,
    recipient: string = '',
  ): Promise<ConversationSenderInfo> {
    const providerId = provider.config.id;
    const adapterSender = typeof provider.getSenderAddress === 'function' ? provider.getSenderAddress() : undefined;
    let profiles: Awaited<ReturnType<typeof messagingProfileRepository.findSendersForOwner>> = [];
    try {
      profiles = await messagingProfileRepository.findSendersForOwner(appId, tenantId, providerId);
    } catch (err: any) {
      // Same fail-open stance as the tenant-level consent lookup above (gap
      // register A7, still open): without the registry the number is only
      // known from the adapter itself. The sender-level STOP check below
      // still fails CLOSED whenever a number IS known.
      console.error(`[routing] messaging-profile lookup failed for ${appId}/${tenantId} via ${providerId}: ${err?.message}`);
    }
    const usable = profiles.filter((p) => !p.supplierId || p.supplierId === supplierId);
    if (adapterSender) {
      const normalized = normalizeMessagingAddress(adapterSender);
      const match = usable.find((p) => p.sender === normalized && p.supplierId === supplierId)
        ?? usable.find((p) => p.sender === normalized);
      return { businessNumber: normalized, messagingProfileId: match?.id ?? null, country: match?.country ?? null };
    }
    const supplierSpecific = supplierId ? usable.filter((p) => p.supplierId === supplierId) : [];
    let pool = supplierSpecific.length > 0 ? supplierSpecific : usable.filter((p) => !p.supplierId);
    if (pool.length > 1) {
      // One local number per country is the platform's model: prefer the
      // registration in the recipient's own country, when the number's
      // calling code identifies it unambiguously.
      const country = countryForE164(recipient);
      if (country) pool = pool.filter((p) => p.country.toUpperCase() === country);
    }
    if (pool.length === 1) {
      return { businessNumber: pool[0].sender, messagingProfileId: pool[0].id, country: pool[0].country };
    }
    return { businessNumber: null };
  }

  // Routes other API requests (Maps, Identity, AI)
  public async routeOther(appId: string, payload: any): Promise<TransactionEvent> {
    const { serviceType = 'maps', providerOverride } = payload;
    let selectedProvider: BaseProvider | null = null;
    let reason = '';

    const providerId = providerOverride || (serviceType === 'maps' ? 'maps' : serviceType === 'identity' ? 'identity' : 'ai');
    const provider = this.registry.getProvider(providerId);

    if (provider && this.registry.isProviderAvailable(providerId) && this.registry.isLiveEligible(providerId)) {
      selectedProvider = provider;
      reason = `Routed to designated API node '${provider.config.name}' for service type '${serviceType}'.`;
    } else {
      const allProviders = this.registry.getAllConfigs();
      const backups = allProviders.filter(
        p => p.category === 'other' && this.registry.isProviderAvailable(p.id) && this.registry.isLiveEligible(p.id),
      );
      if (backups.length > 0) {
        selectedProvider = this.registry.getProvider(backups[0].id) || null;
        reason = `Designated provider '${providerId}' was offline. Routed to backup services node '${selectedProvider?.config.name}'.`;
      }
    }

    if (!selectedProvider) {
      throw new Error(`Routing failure: Service node for '${serviceType}' is offline.`);
    }

    // P1: Wrap provider call with timeout to prevent hung requests
    return await this.dispatch(
      selectedProvider,
      (options) => selectedProvider!.processRequest(appId, payload, reason, options),
    );
  }
}
