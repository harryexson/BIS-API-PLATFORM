// Build-time base URL for the api-gateway service.
//
// In dev this stays empty and vite.config.ts's server.proxy forwards
// relative /v1/* requests to the local gateway. The deployed static site
// has no such proxy — apps/web/vercel.json only rewrites every path to
// index.html for SPA routing — so in production this must be set to the
// gateway's real deployed URL via the VITE_API_BASE_URL env var at build
// time. Without it, every /v1/* fetch here falls through to this app's
// own SPA fallback and gets back HTML instead of the JSON the auth/billing
// flows expect, which is why sign in, sign up, and "get API key" appear to
// do nothing. Mirrors apps/landing/src/main.js's ACCOUNT_APP_URL /
// DEVELOPER_PORTAL_URL pattern.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
