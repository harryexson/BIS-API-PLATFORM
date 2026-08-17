import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RoutingEngine } from './index';
import { ProviderRegistry } from '@company/providers';

describe('RoutingEngine', () => {
  let engine: RoutingEngine;

  beforeEach(() => {
    engine = new RoutingEngine();
  });

  afterEach(() => {
    const registry = ProviderRegistry.getInstance();
    registry.updateProviderConfig('stripe', { status: 'online' });
    registry.updateProviderConfig('nmi', { status: 'online' });
    registry.updateProviderConfig('flutterwave', { status: 'online' });
    registry.updateProviderConfig('pawapay', { status: 'online' });
    registry.updateProviderConfig('paychangu', { status: 'online' });
    registry.updateProviderConfig('airwallex', { status: 'online' });
    registry.updateProviderConfig('infobip', { status: 'online' });
    registry.updateProviderConfig('futuresms', { status: 'online' });
    registry.updateProviderConfig('signalhouse', { status: 'online' });
    registry.updateProviderConfig('email', { status: 'online' });
  });

  describe('routePayment', () => {
    it('routes MWK payments to PayChangu', async () => {
      const result = await engine.routePayment('testapp', {
        amount: 1000,
        currency: 'MWK',
        paymentMethod: 'mobile_money'
      });
      expect(result.providerId).toBe('paychangu');
      expect(result.category).toBe('payment');
      expect(result.status).toBe('success');
    });

    it('falls back to Flutterwave when PayChangu is offline for MWK', async () => {
      const registry = ProviderRegistry.getInstance();
      registry.updateProviderConfig('paychangu', { status: 'offline' });

      const result = await engine.routePayment('testapp', {
        amount: 1000,
        currency: 'MWK',
        paymentMethod: 'mobile_money'
      });
      expect(result.providerId).toBe('flutterwave');
    });

    it('routes East African mobile money to PawaPay', async () => {
      for (const currency of ['KES', 'UGX', 'GHS', 'TZS']) {
        const result = await engine.routePayment('testapp', {
          amount: 500,
          currency,
          paymentMethod: 'mobile_money'
        });
        expect(result.providerId).toBe('pawapay');
      }
    });

    it('routes African card payments to Flutterwave', async () => {
      for (const currency of ['NGN', 'GHS', 'ZAR', 'KES']) {
        const result = await engine.routePayment('testapp', {
          amount: 100,
          currency,
          paymentMethod: 'card'
        });
        expect(result.providerId).toBe('flutterwave');
      }
    });

    it('respects manual provider override', async () => {
      const result = await engine.routePayment('testapp', {
        amount: 100,
        currency: 'USD',
        paymentMethod: 'card',
        providerOverride: 'nmi'
      });
      expect(result.providerId).toBe('nmi');
    });

    it('falls back when override provider is offline', async () => {
      const registry = ProviderRegistry.getInstance();
      registry.updateProviderConfig('nmi', { status: 'offline' });

      const result = await engine.routePayment('testapp', {
        amount: 100,
        currency: 'USD',
        paymentMethod: 'card',
        providerOverride: 'nmi'
      });
      expect(result.providerId).not.toBe('nmi');
    });

    it('returns a valid TransactionEvent structure', async () => {
      const result = await engine.routePayment('testapp', {
        amount: 50,
        currency: 'USD',
        paymentMethod: 'card'
      });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('appId', 'testapp');
      expect(result).toHaveProperty('category', 'payment');
      expect(result).toHaveProperty('providerId');
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('latency');
      expect(result).toHaveProperty('cost');
      expect(result).toHaveProperty('decisionReason');
      expect(result).toHaveProperty('payload');
      expect(result).toHaveProperty('response');
    });

    it('throws when all payment providers are offline', async () => {
      const registry = ProviderRegistry.getInstance();
      registry.updateProviderConfig('stripe', { status: 'offline' });
      registry.updateProviderConfig('nmi', { status: 'offline' });
      registry.updateProviderConfig('flutterwave', { status: 'offline' });
      registry.updateProviderConfig('pawapay', { status: 'offline' });
      registry.updateProviderConfig('paychangu', { status: 'offline' });
      registry.updateProviderConfig('airwallex', { status: 'offline' });

      await expect(
        engine.routePayment('testapp', { amount: 100, currency: 'USD', paymentMethod: 'card' })
      ).rejects.toThrow();
    });
  });

  describe('routeMessage', () => {
    it('routes email addresses to Email provider', async () => {
      const result = await engine.routeMessage('testapp', {
        recipient: 'user@example.com',
        content: 'Hello'
      });
      expect(result.providerId).toBe('email');
      expect(result.category).toBe('messaging');
    });

    it('routes SMS to Infobip by default', async () => {
      const result = await engine.routeMessage('testapp', {
        recipient: '+15005550006',
        content: 'Hello'
      });
      expect(result.providerId).toBe('infobip');
      expect(result.category).toBe('messaging');
    });

    it('routes WhatsApp-format messages to SignalHouse', async () => {
      const result = await engine.routeMessage('testapp', {
        recipient: '+15005550006',
        content: 'wa: Hello this is a WhatsApp message'
      });
      expect(result.providerId).toBe('signalhouse');
    });

    it('routes long messages to SignalHouse', async () => {
      const longContent = 'A'.repeat(301);
      const result = await engine.routeMessage('testapp', {
        recipient: '+15005550006',
        content: longContent
      });
      expect(result.providerId).toBe('signalhouse');
    });

    it('respects manual override for messaging', async () => {
      const result = await engine.routeMessage('testapp', {
        recipient: '+15005550006',
        content: 'Hello',
        providerOverride: 'futuresms'
      });
      expect(result.providerId).toBe('futuresms');
    });

    it('falls back when override is offline', async () => {
      const registry = ProviderRegistry.getInstance();
      registry.updateProviderConfig('infobip', { status: 'offline' });

      const result = await engine.routeMessage('testapp', {
        recipient: '+15005550006',
        content: 'Hello',
        providerOverride: 'infobip'
      });
      expect(result.providerId).not.toBe('infobip');
    });

    it('throws when all messaging providers are offline', async () => {
      const registry = ProviderRegistry.getInstance();
      registry.updateProviderConfig('infobip', { status: 'offline' });
      registry.updateProviderConfig('futuresms', { status: 'offline' });
      registry.updateProviderConfig('signalhouse', { status: 'offline' });
      registry.updateProviderConfig('email', { status: 'offline' });

      await expect(
        engine.routeMessage('testapp', { recipient: '+15005550006', content: 'Hello' })
      ).rejects.toThrow();
    });
  });

  describe('routeOther', () => {
    it('routes maps requests to Maps provider', async () => {
      const result = await engine.routeOther('testapp', {
        serviceType: 'maps',
        payload: { action: 'geocode', address: '1600 Amphitheatre Pkwy' }
      });
      expect(result.providerId).toBe('maps');
      expect(result.category).toBe('other');
    });

    it('routes identity requests to Identity provider', async () => {
      const result = await engine.routeOther('testapp', {
        serviceType: 'identity',
        payload: { action: 'verify', token: 'test-token' }
      });
      expect(result.providerId).toBe('identity');
      expect(result.category).toBe('other');
    });

    it('routes AI requests to AI provider', async () => {
      const result = await engine.routeOther('testapp', {
        serviceType: 'ai',
        payload: { prompt: 'Hello' }
      });
      expect(result.providerId).toBe('ai');
      expect(result.category).toBe('other');
    });

    it('respects manual override for other services', async () => {
      const result = await engine.routeOther('testapp', {
        serviceType: 'maps',
        providerOverride: 'identity',
        payload: {}
      });
      expect(result.providerId).toBe('identity');
    });

    it('falls back to another provider when designated is offline', async () => {
      const registry = ProviderRegistry.getInstance();
      registry.updateProviderConfig('maps', { status: 'offline' });

      const result = await engine.routeOther('testapp', { serviceType: 'maps', payload: {} });
      expect(result.providerId).not.toBe('maps');
      expect(result.category).toBe('other');
    });

    it('throws when all other providers are offline', async () => {
      const registry = ProviderRegistry.getInstance();
      registry.updateProviderConfig('maps', { status: 'offline' });
      registry.updateProviderConfig('identity', { status: 'offline' });
      registry.updateProviderConfig('ai', { status: 'offline' });

      await expect(
        engine.routeOther('testapp', { serviceType: 'maps', payload: {} })
      ).rejects.toThrow();
    });
  });
});
