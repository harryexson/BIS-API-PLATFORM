// Minimal ambient typing for Stripe.js v3, loaded globally via the
// <script src="https://js.stripe.com/v3/"> tag in index.html — not an
// npm package, so there's no @types package to pull in. Covers only the
// Elements + createPaymentMethod surface RequestPlayground.tsx uses.
interface StripeCardElement {
  mount(selector: string | HTMLElement): void;
  unmount(): void;
  on(event: 'change', handler: (event: { error?: { message: string } }) => void): void;
}

interface StripeElements {
  create(type: 'card'): StripeCardElement;
}

interface StripePaymentMethodResult {
  paymentMethod?: { id: string };
  error?: { message: string };
}

interface Stripe {
  elements(): StripeElements;
  createPaymentMethod(params: { type: 'card'; card: StripeCardElement }): Promise<StripePaymentMethodResult>;
}

interface Window {
  Stripe?(publishableKey: string): Stripe;
}
