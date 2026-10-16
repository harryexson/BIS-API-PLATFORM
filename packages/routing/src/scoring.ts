/**
 * The subset of fields scoring actually needs — structurally satisfied by
 * both ProviderCapabilityMatch (capability-matched candidates) and
 * ProviderConfig (the plain admin-configured record), so callers don't
 * need to convert between the two shapes just to get a score.
 */
export interface ScorableCandidate {
  id: string;
  weight: number;
  errorRate?: number;
  transactionFeePercent?: number;
  transactionFeeFlat?: number;
  messageCost?: number;
}

/**
 * Turns a capability-matched candidate into a single selection weight that
 * blends three real, already-tracked signals instead of the admin-set
 * `weight` alone:
 *
 *  - successFactor: the provider's live rolling error rate
 *    (ProviderRegistry.recordTraffic, fed by every real request/response —
 *    see services/api-gateway/src/app.ts's observe()). Floored at 0.05 so
 *    a struggling-but-not-yet-circuit-broken provider is heavily
 *    deprioritized rather than made literally unreachable by this score
 *    alone — the circuit breaker (packages/providers/src/registry.ts) is
 *    still the hard cutoff that removes a provider from candidacy
 *    entirely.
 *  - costFactor: cheaper providers score higher. Payments use the
 *    configured transactionFeeFlat + transactionFeePercent applied to the
 *    real transaction amount; messaging uses the flat messageCost. A
 *    provider with no cost configured (0/undefined) gets a neutral 1 —
 *    never treated as "free and therefore infinitely preferred".
 *
 * `weight * successFactor^2 * costFactor`: successFactor is squared so
 * live health dominates the decision faster than cost does — this is
 * meant to behave like "route away from an increasingly unhealthy
 * provider well before its circuit trips", not primarily a cost optimizer.
 */
export function computeProviderScore(
  candidate: ScorableCandidate,
  opts: { amount?: number } = {},
): number {
  const successFactor = Math.max(0.05, (100 - (candidate.errorRate ?? 0)) / 100);

  let costBasis = 0;
  if (candidate.transactionFeePercent !== undefined || candidate.transactionFeeFlat !== undefined) {
    const amount = opts.amount ?? 0;
    costBasis = (candidate.transactionFeeFlat ?? 0) + amount * ((candidate.transactionFeePercent ?? 0) / 100);
  } else if (candidate.messageCost !== undefined) {
    costBasis = candidate.messageCost;
  }
  const costFactor = costBasis > 0 ? 1 / (1 + costBasis) : 1;

  return Math.max(candidate.weight, 0.01) * successFactor * successFactor * costFactor;
}

/**
 * Weighted-random pick using an arbitrary positive-score function — the
 * same algorithm routePayment/routeMessage each hand-rolled three separate
 * times against raw `weight`; centralized here so scoring changes (like
 * computeProviderScore above) apply everywhere at once.
 */
export function weightedRandomSelect<T>(items: T[], scoreFn: (item: T) => number): T {
  if (items.length === 1) return items[0];
  const scored = items.map((item) => ({ item, score: Math.max(scoreFn(item), 0.0001) }));
  const total = scored.reduce((sum, s) => sum + s.score, 0);
  let roll = Math.random() * total;
  for (const s of scored) {
    roll -= s.score;
    if (roll <= 0) return s.item;
  }
  return scored[scored.length - 1].item;
}

/** Candidates ordered best-first by computeProviderScore — used both for
 * the initial pick and to build the cascading fallback order. */
export function rankByScore<T extends ScorableCandidate>(
  candidates: T[],
  opts: { amount?: number } = {},
): T[] {
  return [...candidates].sort((a, b) => computeProviderScore(b, opts) - computeProviderScore(a, opts));
}
