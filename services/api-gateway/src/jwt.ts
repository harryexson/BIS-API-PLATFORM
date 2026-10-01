import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT sign/verify for portal user sessions (developer portal
 * login). Deliberately hand-rolled rather than pulling in a dependency —
 * same reasoning as this codebase's existing HMAC webhook-signature code:
 * it's a small, well-understood primitive built on Node's crypto module.
 */

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export interface PortalTokenPayload {
  userId: string;
  applicationId: string;
  email: string;
}

export function signPortalToken(payload: PortalTokenPayload, secret: string, expiresInSec = 24 * 3600): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSec };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedBody = base64url(JSON.stringify(body));
  const signature = createHmac('sha256', secret).update(`${encodedHeader}.${encodedBody}`).digest('base64url');

  return `${encodedHeader}.${encodedBody}.${signature}`;
}

export function verifyPortalToken(token: string, secret: string): (PortalTokenPayload & { exp: number }) | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, signature] = parts;

  const expectedSignature = createHmac('sha256', secret).update(`${encodedHeader}.${encodedBody}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const body = JSON.parse(fromBase64url(encodedBody).toString('utf8'));
    if (typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}
