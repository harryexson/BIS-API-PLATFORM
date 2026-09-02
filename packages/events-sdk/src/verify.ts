import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformEvent } from './types';

export function computeSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const a = Buffer.from(computeSignature(rawBody, secret));
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseEvent(rawBody: string): PlatformEvent {
  return JSON.parse(rawBody) as PlatformEvent;
}

export function constructEvent(rawBody: string, signature: string, secret: string): PlatformEvent {
  if (!verifySignature(rawBody, signature, secret)) {
    throw new Error('Webhook signature verification failed');
  }
  return parseEvent(rawBody);
}
