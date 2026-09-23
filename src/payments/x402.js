// x402 payment-gating — runtime-agnostic, v2 protocol.
// Config comes from the `env` argument (Node: process.env; Worker: env bindings).

const USDC_BASE_DECIMALS = 6;

// Base mainnet USDC (Circle) — canonical address used in x402 examples.
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function cfg(env) {
  return {
    mode: env.PAYMENT_MODE || env.X402_MODE || 'live', // FAIL-CLOSED: unset => live (402), never free
    priceUsdc: env.PRICE_USDC || env.X402_PRICE_USDC || '0.005',
    payTo: env.X402_PAY_TO || '0x2091125bFE4259b2CfA889165Beb6290d0Df5DeA',
    facilitatorUrl: env.X402_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402',
    network: env.X402_NETWORK || 'eip155:8453', // Base mainnet
    asset: env.X402_ASSET || USDC_BASE_MAINNET,
  };
}

function priceInAtomicUnits(priceUsdc) {
  return String(Math.round(parseFloat(priceUsdc) * 10 ** USDC_BASE_DECIMALS));
}

export function paymentRequirements(resourceUrl, env) {
  const c = cfg(env);
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: resourceUrl,
      description: 'Token risk check',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: c.network,
        amount: priceInAtomicUnits(c.priceUsdc),
        asset: c.asset,
        payTo: c.payTo,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USDC',
          version: '2',
          resourceUrl,
        },
      },
    ],
  };
}

async function verifyWithFacilitator(paymentHeader, resourceUrl, env) {
  const c = cfg(env);
  const requirements = paymentRequirements(resourceUrl, env);
  const body = JSON.stringify({ x402Version: 2, paymentHeader, paymentRequirements: requirements });

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
      headers: {
        'content-type': 'application/json',
        'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequirements(resourceUrl, env))).toString('base64'),
      },
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