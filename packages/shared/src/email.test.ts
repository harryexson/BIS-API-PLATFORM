import { describe, it, expect, afterEach, vi } from 'vitest';
import { sendTransactionalEmail, verificationEmailHtml, passwordResetEmailHtml } from './email';

describe('sendTransactionalEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips sending and reports why, without throwing, when RESEND_API_KEY is not configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await sendTransactionalEmail({ to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' }, {});

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.sent).toBe(false);
    expect(result.error).toMatch(/RESEND_API_KEY/);
  });

  it('sends a real POST to /emails with Bearer auth and the documented body shape', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email-123' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await sendTransactionalEmail(
      { to: 'a@example.com', subject: 'Verify your email', html: '<p>verify</p>' },
      { RESEND_API_KEY: 're_test_123', RESEND_FROM_EMAIL: 'Test <test@example.com>' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer re_test_123');
    const body = JSON.parse(opts.body);
    expect(body.from).toBe('Test <test@example.com>');
    expect(body.to).toEqual(['a@example.com']);
    expect(body.subject).toBe('Verify your email');

    expect(result.sent).toBe(true);
    expect(result.id).toBe('email-123');
  });

  it('falls back to the Resend shared onboarding sender when RESEND_FROM_EMAIL is not set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email-456' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await sendTransactionalEmail({ to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' }, { RESEND_API_KEY: 're_test_123' });

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.from).toMatch(/resend\.dev/);
  });

  it('reports failure (not thrown) without crashing the caller on a non-2xx response', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: 'validation_error', message: 'Invalid `to` field.' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await sendTransactionalEmail(
      { to: 'not-an-email', subject: 'Hi', html: '<p>hi</p>' },
      { RESEND_API_KEY: 're_test_123' },
    );

    expect(result.sent).toBe(false);
    expect(result.error).toBe('Invalid `to` field.');
  });

  it('reports failure (not thrown) when the request itself throws (network error)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network unreachable'));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await sendTransactionalEmail(
      { to: 'a@example.com', subject: 'Hi', html: '<p>hi</p>' },
      { RESEND_API_KEY: 're_test_123' },
    );

    expect(result.sent).toBe(false);
    expect(result.error).toBe('network unreachable');
  });
});

describe('email templates', () => {
  it('verificationEmailHtml embeds the verify URL as a link', () => {
    const html = verificationEmailHtml('https://app.example.com/verify?token=abc');
    expect(html).toContain('https://app.example.com/verify?token=abc');
  });

  it('passwordResetEmailHtml embeds the reset URL as a link', () => {
    const html = passwordResetEmailHtml('https://app.example.com/reset?token=xyz');
    expect(html).toContain('https://app.example.com/reset?token=xyz');
  });
});
