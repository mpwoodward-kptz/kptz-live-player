/**
 * KPTZ Spinitron API Proxy — Cloudflare Worker
 *
 * This Worker sits between the browser-based player and the Spinitron v2 API,
 * forwarding requests and adding CORS headers so the player can call the API
 * from a browser (which Spinitron blocks directly).
 *
 * It also keeps your Spinitron API key out of the player HTML.
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 * 1. In the Cloudflare dashboard, go to Workers & Pages → Create Worker
 * 2. Paste this entire file into the editor
 * 3. Add your Spinitron API key as a Secret:
 *    Workers & Pages → your worker → Settings → Variables → Add secret
 *    Name:  SPINITRON_API_KEY
 *    Value: (your key from Spinitron Admin → Automation & API)
 * 4. Deploy
 * 5. Copy the worker URL (e.g. https://kptz-spinitron.yourname.workers.dev)
 *    and paste it into CONFIG.proxyBase in player.html
 *
 * ── Allowed endpoints (Spinitron read-only) ────────────────────────────────
 *   GET /spins?count=1          → most recent spin
 *   GET /playlists/:id          → playlist (to get show_id and times)
 *   GET /shows/:id              → show name
 *
 * ── Security notes ─────────────────────────────────────────────────────────
 * - Only GET requests are forwarded; POST/PUT/DELETE are blocked.
 * - Only the three endpoint patterns above are allowed.
 * - The API key is stored as a Cloudflare secret, never in client code.
 * - You can optionally restrict ALLOWED_ORIGINS to your specific domains.
 * ───────────────────────────────────────────────────────────────────────────
 */

// Optional: restrict which origins may call this proxy.
// Set to ['*'] to allow all origins (fine for a public radio station).
const ALLOWED_ORIGINS = ['*'];

const SPINITRON_BASE = 'https://spinitron.com/api';

// Only these path patterns are proxied
const ALLOWED_PATHS = [
  /^\/spins(\?.*)?$/,         // /spins  or  /spins?count=1
  /^\/playlists\/\d+$/,       // /playlists/12345
  /^\/shows\/\d+$/,           // /shows/12345
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname + url.search;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, {});
    }

    // Only GET
    if (request.method !== 'GET') {
      return corsResponse('Method not allowed', 405);
    }

    // Validate path
    const allowed = ALLOWED_PATHS.some(pattern => pattern.test(url.pathname + (url.search || '')));
    if (!allowed) {
      return corsResponse('Not found', 404);
    }

    // Require API key secret
    const apiKey = env.SPINITRON_API_KEY;
    if (!apiKey) {
      console.error('SPINITRON_API_KEY secret is not set');
      return corsResponse('Proxy misconfigured', 500);
    }

    // Forward to Spinitron
    const upstreamUrl = `${SPINITRON_BASE}${path}`;
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
          'User-Agent': 'KPTZ-Player/1.0',
        },
        cf: { cacheTtl: 25 }, // Cloudflare edge cache — slightly under 30s poll interval
      });
    } catch (err) {
      console.error('Upstream fetch error:', err);
      return corsResponse('Upstream error', 502);
    }

    if (!upstreamRes.ok) {
      return corsResponse(`Spinitron error: ${upstreamRes.status}`, upstreamRes.status);
    }

    const body = await upstreamRes.text();
    return corsResponse(body, 200, { 'Content-Type': 'application/json' });
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function corsResponse(body, status = 200, extraHeaders = {}) {
  const origin = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extraHeaders,
  };

  if (body === null) {
    return new Response(null, { status, headers });
  }
  return new Response(body, { status, headers });
}
