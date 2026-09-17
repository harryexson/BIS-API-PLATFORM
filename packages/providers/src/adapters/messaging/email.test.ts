import { describe, it, expect, afterEach, vi } from 'vitest';
import { ProviderConfig } from '@company/schemas';

const { sendTransactionalEmail } = vi.hoisted(() => ({
  sendTransactionalEmail: vi.fn(),
}));

vi.mock('@company/shared', () => ({ sendTransactionalEmail }));

import { EmailProvider } from './email';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'email',
    name: 'Email SMTP',
    category: 'messaging',
    status: 'online',
    weight: 50,
    latencyMin: 10,
    latencyMax: 20,
    messageCost: 0.0001,
    ...overrides,
  };
}

describe('EmailProvider', () => {
  const originalApiKey = process.env.RESEND_API_KEY;

  afterEach(() => {
    vi.clearAllMocks();
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
  });

  describe('isConfigured()', () => {
    it('is false with no credentials, true once set via env or setSecrets()', () => {
      delete process.env.RESEND_API_KEY;
      const provider = new EmailProvider(makeConfig());
      expect(provider.isConfigured()).toBe(false);

      process.env.RESEND_API_KEY = 're_test_123';
      expect(provider.isConfigured()).toBe(true);

      delete process.env.RESEND_API_KEY;
      expect(provider.isConfigured()).toBe(false);
      provider.setSecrets({ api_key: 're_live_from_admin_console' });
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe('without an API key configured (simulated fallback)', () => {
    it('never calls sendTransactionalEmail and returns a fabricated-but-labeled simulated response', async () => {
      delete process.env.RESEND_API_KEY;

      const provider = new EmailProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { recipient: 'user@example.com', subject: 'Hi', content: 'Hello' },
        'test',
      );

      expect(sendTransactionalEmail).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
      expect(event.id).toMatch(/^email-/);
    });
  });

  describe('with an API key but missing recipient/content', () => {
    it('falls back to simulated rather than sending an empty email', async () => {
      process.env.RESEND_API_KEY = 're_test_123';

      const provider = new EmailProvider(makeConfig());
      const event = await provider.processRequest('app1', { recipient: '', content: '' }, 'test');

      expect(sendTransactionalEmail).not.toHaveBeenCalled();
      expect(event.status).toBe('success');
    });
  });

  describe('with an API key, recipient, and content (real send path)', () => {
    it('calls sendTransactionalEmail with an escaped HTML body', async () => {
      process.env.RESEND_API_KEY = 're_test_123';
      sendTransactionalEmail.mockResolvedValue({ sent: true, id: 're_abc123' });

      const provider = new EmailProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { recipient: 'user@example.com', subject: 'Receipt', content: 'Thanks <for> your order\nSee you soon' },
        'test',
      );

      expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
      const [params] = sendTransactionalEmail.mock.calls[0];
      expect(params.to).toBe('user@example.com');
      expect(params.subject).toBe('Receipt');
      expect(params.html).toContain('&lt;for&gt;');
      expect(params.html).toContain('<br>');

      expect(event.status).toBe('success');
      expect(event.id).toBe('re_abc123');
      expect(event.response.accepted).toEqual(['user@example.com']);
    });

    it('reports failure (not success) when Resend fails to send', async () => {
      process.env.RESEND_API_KEY = 're_test_123';
      sendTransactionalEmail.mockResolvedValue({ sent: false, error: 'RESEND_API_KEY not configured' });

      const provider = new EmailProvider(makeConfig());
      const event = await provider.processRequest(
        'app1',
        { recipient: 'user@example.com', subject: 'Hi', content: 'Hello' },
        'test',
      );

      expect(event.status).toBe('failed');
      expect(event.error).toBe('RESEND_API_KEY not configured');
    });
  });

  it('reports offline/maintenance status without calling sendTransactionalEmail', async () => {
    process.env.RESEND_API_KEY = 're_test_123';
    const provider = new EmailProvider(makeConfig({ status: 'offline' }));

    await expect(
      provider.processRequest('app1', { recipient: 'user@example.com', content: 'Hello' }, 'test'),
    ).rejects.toThrow();
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});
