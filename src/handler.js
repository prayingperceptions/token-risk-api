// Runtime-agnostic request handler for token-risk-api.
// Used by src/server.js (Node) and worker.js (Cloudflare/Vercel Edge).
// All config comes from the `env` argument — no process.env reads here.

import { gatePayment } from './payments/x402.js';
import { checkToken } from './sources/risk.js';

function json(status, body, headers = {}) {
  return { status, body, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } };
}

export async function handle(req, env) {
  const { method, headers } = req;

  // Vercel may invoke /api/index.js directly or include function path prefixes.
  let path = req.path;
  if (typeof path === 'string') {
    path = path.replace(/^\/api\/index\.js/, '').replace(/\/$/, '') || '/';
  }

  let query = req.query;

  if (method !== 'GET') return json(405, { error: 'method_not_allowed' });

  if (path === '/debug') {
    return json(200, {
      debug: true,
      rawPath: req.path,
      normalizedPath: path,
      query: query && (typeof query.get === 'function' ? Object.fromEntries(query) : query),
      paymentMode: env.PAYMENT_MODE || env.X402_MODE || 'mock',
    });
  }

  if (path === '/health' || path === '/') {
    return json(200, {
      ok: true,
      service: 'token-risk-api',
      version: '0.1.0',
      paymentMode: env.PAYMENT_MODE || env.X402_MODE || 'mock',
      priceUsdc: env.PRICE_USDC || env.X402_PRICE_USDC || '0.005',
      network: env.X402_NETWORK || 'base',
    });
  }

  if (path === '/v1/risk') {
    const token = query && typeof query.get === 'function' ? query.get('token') : (query && query.token);
    const chain = query && typeof query.get === 'function' ? query.get('chain') : (query && query.chain);
    if (!token) return json(400, { error: 'missing required query param: token' });

    let gate;
    try {
      gate = await gatePayment({ headers }, req.resource || (path + (token ? `?token=***}` : '')), env);
    } catch (err) {
      return json(502, { error: 'payment verification failed', detail: String(err && err.message || err) });
    }
    if (!gate.paid) return json(gate.status, JSON.parse(gate.body), gate.headers);

    try {
      const report = await checkToken(token, chain, fetch);
      return json(200, { ...report, payment: gate.mode ? { mode: gate.mode } : { txHash: gate.txHash || null } });
    } catch (err) {
      return json(500, { error: 'risk check failed', detail: String(err && err.message || err) });
    }
  }

  return json(404, { error: 'not found', rawPath: req.path, normalizedPath: path, endpoints: ['/health', '/v1/risk?token=***<query>&chain=<chain?>', '/debug'] });
}
