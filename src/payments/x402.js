// x402 payment-gating — runtime-agnostic version.
// Config comes from the `env` argument (Node: process.env; Worker: env bindings).

const USDC_BASE_DECIMALS = 6;

function cfg(env) {
  return {
    mode: env.PAYMENT_MODE || env.X402_MODE || 'mock',
    priceUsdc: env.PRICE_USDC || env.X402_PRICE_USDC || '0.005',
    payTo: env.X402_PAY_TO || '0x2091125bFE4259b2CfA889165Beb6290d0Df5DeA',
    facilitatorUrl: env.X402_FACILITATOR_URL || '',
    network: env.X402_NETWORK || 'base',
  };
}

function priceInAtomicUnits(priceUsdc) {
  return String(Math.round(parseFloat(priceUsdc) * 10 ** USDC_BASE_DECIMALS));
}

export function paymentRequirements(resourceUrl, env) {
  const c = cfg(env);
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: c.network,
        maxAmountRequired: priceInAtomicUnits(c.priceUsdc),
        resource: resourceUrl,
        description: 'Token risk check',
        mimeType: 'application/json',
        payTo: c.payTo,
        asset: 'USDC',
        maxTimeoutSeconds: 60,
      },
    ],
    error: 'Payment required',
  };
}

async function verifyWithFacilitator(paymentHeader, resourceUrl, env) {
  const c = cfg(env);
  const requirements = paymentRequirements(resourceUrl, env).accepts[0];
  const body = JSON.stringify({ x402Version: 1, paymentHeader, paymentRequirements: requirements });

  const res = await fetch(`${c.facilitatorUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) return { ok: false, reason: `facilitator verify HTTP ${res.status}` };
  const v = await res.json();
  if (!v.isValid) return { ok: false, reason: v.invalidReason || 'invalid payment' };

  const settle = await fetch(`${c.facilitatorUrl}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!settle.ok) return { ok: false, reason: `facilitator settle HTTP ${settle.status}` };
  const s = await settle.json();
  if (!s.success) return { ok: false, reason: s.error || 'settlement failed' };
  return { ok: true, txHash: s.txHash || null };
}

// Returns { paid: true } or { paid: false, status, headers, body(JSON string) }.
export async function gatePayment(req, resourceUrl, env) {
  const c = cfg(env);
  if (c.mode === 'mock') return { paid: true, mode: 'mock' };

  const paymentHeader = req.headers && (req.headers['x-payment'] || req.headers['X-Payment']);
  if (!paymentHeader) {
    return {
      paid: false,
      status: 402,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paymentRequirements(resourceUrl, env)),
    };
  }
  const verdict = await verifyWithFacilitator(paymentHeader, resourceUrl, env);
  if (!verdict.ok) {
    return {
      paid: false,
      status: 402,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...paymentRequirements(resourceUrl, env), error: verdict.reason }),
    };
  }
  return { paid: true, txHash: verdict.txHash };
}
