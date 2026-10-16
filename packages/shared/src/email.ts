/**
 * Real transactional email delivery via Resend
 * (docs/IMPLEMENTATION_BASELINE.md §4 item 15). Before this, the platform
 * had no delivery path at all for account-verification / password-reset
 * emails — the tokens were only ever surfaced directly in the API
 * response outside production (see services/api-gateway/src/app.ts's
 * /v1/api/auth/signup, /resend-verification, /request-password-reset),
 * which meant a real person in production had no way to receive one.
 *
 * Uses Resend's HTTP API directly (POST /emails) rather than its SDK, to
 * match every other real integration in this platform (all payment/
 * messaging adapters call their provider's REST API directly via
 * BaseProvider.http_request, no vendor SDKs) and to avoid adding a
 * dependency for a single endpoint call. Facts below (endpoint, auth,
 * request/response shape) were verified via web search against Resend's
 * public API reference on 2026-09-14 (this environment's outbound network
 * access to resend.com is restricted, the same constraint documented for
 * every provider adapter in packages/providers), not a live account.
 *
 * Environment variables:
 *   RESEND_API_KEY   — re_...
 *   RESEND_FROM_EMAIL — e.g. "BIS API Platform <noreply@yourdomain.com>";
 *                       defaults to Resend's own shared onboarding sender,
 *                       which works without a verified domain but is
 *                       rate-limited and meant for testing only.
 */

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export interface SendEmailResult {
  sent: boolean;
  id?: string;
  error?: string;
}

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'BIS API Platform <onboarding@resend.dev>';

/**
 * Sends a transactional email. Returns { sent: false } rather than
 * throwing when RESEND_API_KEY isn't configured or the send fails — a
 * failed/skipped email must never block the account action that
 * triggered it (signup, password-reset request, etc.); the caller logs
 * the outcome and, outside production, still has the token available in
 * the API response as a fallback for testing.
 */
export async function sendTransactionalEmail(
  params: SendEmailParams,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SendEmailResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, error: 'RESEND_API_KEY not configured' };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || DEFAULT_FROM,
        to: [params.to],
        subject: params.subject,
        html: params.html,
      }),
    });

    const body = await res.json().catch(() => undefined);

    if (!res.ok) {
      return { sent: false, error: body?.message || `Resend API error: HTTP ${res.status}` };
    }

    return { sent: true, id: body?.id };
  } catch (err: any) {
    return { sent: false, error: err.message || 'Email send failed' };
  }
}

export function verificationEmailHtml(verifyUrl: string): string {
  return `<p>Welcome! Please verify your email address to activate your account.</p>
<p><a href="${verifyUrl}">Verify your email</a></p>
<p>If you didn't create this account, you can safely ignore this email.</p>`;
}

export function passwordResetEmailHtml(resetUrl: string): string {
  return `<p>We received a request to reset your password.</p>
<p><a href="${resetUrl}">Reset your password</a></p>
<p>If you didn't request this, you can safely ignore this email — your password will not be changed.</p>`;
}
