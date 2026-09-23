// Vercel serverless function adapter.
// Vercel routes all requests to this single catch-all function.
// Environment variables set in Vercel dashboard: PAYMENT_MODE, X402_PAY_TO,
// X402_FACILITATOR_URL, X402_NETWORK, PRICE_USDC.

import { handle } from '../src/handler.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);

  const result = await handle(
    { method: req.method, path: url.pathname, query: url.searchParams, headers, resource: url.toString() },
    process.env,
  );

  res.status(result.status);
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.json(result.body);
}
