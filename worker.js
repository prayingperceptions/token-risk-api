// Cloudflare Worker adapter (optional deployment target).
// wrangler.toml would set: main = "worker.js", nodejs_compat not required (fetch-only).
// Configure env vars as Worker secrets/vars: PAYMENT_MODE, PAY_TO, FACILITATOR_URL, etc.
import { handle } from './src/handler.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const result = await handle(
      { method: request.method, path: url.pathname, query: url.searchParams, headers, resource: url.toString() },
      env || {},
    );
    return new Response(JSON.stringify(result.body, null, 2), {
      status: result.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...(result.headers || {}) },
    });
  },
};
