// x402 payment-gating — runtime-agnostic, v2 protocol.
// Config comes from the `env` argument (Node: process.env; Worker: env bindings).

const USDC_BASE_DECIMALS = 6;

// Base mainnet USDC (Circle) — canonical address used in x402 examples.
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function cfg(env) {
  const mode = env.PAYMENT_MODE || env.X402_MODE || 'live'; // FAIL-CLOSED: unset => live (402), never free
  const payTo = env.X402_PAY_TO;
  // FAIL-CLOSED (audit #4): in paid mode require an EXPLICIT X402_PAY_TO env;
  // never silently charge to a code-default address. Refuse loudly instead.
  if (mode === 'live' && !payTo) {
    throw new Error('X402_PAY_TO env is required when PAYMENT_MODE=live (fail-closed: refusing to settle to a default address)');
  }
  return {
    mode,
    priceUsdc: env.PRICE_USDC || env.X402_PRICE_USDC || '0.005',
    payTo: payTo || '0x2091125bFE4259b2CfA889165Beb6290d0Df5DeA', // dev-only fallback when not live
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
    // x402 v2 spec + CDP Bazaar validator: `resource` MUST be an object with a
    // `url` field. A bare string fails validation outright ("cannot unmarshal
    // string into Go struct field PaymentRequired.resource"). description and
    // mimeType live inside the resource object; top-level copies are kept for
    // older clients that read them there.
    resource: {
      url: resourceUrl,
      description: 'Pay-per-call crypto token risk intelligence over x402 on Base mainnet. Given a contract address or symbol (EVM or Solana), returns a 0-100 risk score with A-F grade, market data (liquidity, age), and contract security flags (honeypot, hidden owner, mintable, taxes, holder concentration). $0.005 USDC/call, no signup, no API key.',
      mimeType: 'application/json',
    },
    description: 'Pay-per-call crypto token risk intelligence over x402 on Base mainnet. Given a contract address or symbol (EVM or Solana), returns a 0-100 risk score with A-F grade, market data (liquidity, age), and contract security flags (honeypot, hidden owner, mintable, taxes, holder concentration). $0.005 USDC/call, no signup, no API key.',
    mimeType: 'application/json',
    extensions: {
      bazaar: {
        info: {
          input: {
            type: 'http',
            method: 'GET',
            queryParams: {
              token: {
                type: 'string',
                description: 'Contract address (0x...) or token symbol to risk-check',
              },
              chain: {
                type: 'string',
                enum: ['ethereum', 'bsc', 'polygon', 'arbitrum', 'base', 'optimism', 'avalanche', 'solana'],
                description: 'Chain hint (auto-detected if omitted)',
              },
            },
          },
          output: {
            type: 'json',
            example: {
              token: '0x2091125bFE4259b2CfA889165Beb6290d0Df5DeA',
              score: 42,
              grade: 'B',
              verdict: 'moderate risk',
              reasons: ['holder concentration 52%', 'tax 3% on buy'],
              market: { chain: 'base', liquidityUsd: 100000, ageDays: 30 },
              security: { honeypot: false, hiddenOwner: false, mintable: true },
            },
          },
        },
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            input: { type: 'object' },
            output: { type: 'object' },
          },
          required: ['input'],
        },
      },
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

  // CDP facilitator calls are JWT-authenticated when CDP_API_KEY_ID /
  // CDP_API_KEY_SECRET are configured; without them we keep today's
  // unauthenticated behavior (CDP answers 401 -> caller sees 402).
  // A successful CDP settlement is what indexes the resource in the x402 Bazaar.
  const verifyAuth = await cdpAuthHeaders(env, 'POST', `${c.facilitatorUrl}/verify`);
  const res = await fetch(`${c.facilitatorUrl}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...verifyAuth },
    body,
  });
  if (!res.ok) return { ok: false, reason: `facilitator verify HTTP ${res.status}` };
  const v = await res.json();
  if (!v.isValid) return { ok: false, reason: v.invalidReason || 'invalid payment' };

  const settleAuth = await cdpAuthHeaders(env, 'POST', `${c.facilitatorUrl}/settle`);
  const settle = await fetch(`${c.facilitatorUrl}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...settleAuth },
    body,
  });
  if (!settle.ok) return { ok: false, reason: `facilitator settle HTTP ${settle.status}` };
  const s = await settle.json();
  if (!s.success) return { ok: false, reason: s.error || 'settlement failed' };
  return { ok: true, txHash: s.txHash || null };
}


// -- CDP facilitator JWT auth (dependency-free, WebCrypto) ------------------
// Mirrors @coinbase/cdp-sdk generateJwt for Ed25519 keys (verified against
// the SDK source): header {alg:'EdDSA',kid,typ:'JWT',nonce}, claims
// {sub,iss:'cdp',aud:['cdp_service'],uris:['<METHOD> <host><path>'],iat,nbf,exp}.
// The CDP secret is a 64-byte base64 Ed25519 key (32-byte seed + 32-byte pubkey).
// Reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from env. Returns {} when unset so
// callers keep today's unauthenticated behavior.
const _te = new TextEncoder();
function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}
async function cdpJwt(apiKeyId, apiKeySecret, method, host, path) {
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
  if (!subtle) throw new Error('WebCrypto subtle unavailable — cannot sign CDP JWT');
  const raw = b64ToBytes(apiKeySecret);
  if (raw.length !== 64) throw new Error('CDP_API_KEY_SECRET must be a 64-byte base64 Ed25519 key');
  const jwk = { kty: 'OKP', crv: 'Ed25519', d: b64url(raw.slice(0, 32)), x: b64url(raw.slice(32)) };
  const key = await subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const nb = new Uint8Array(16);
  if (crypto.getRandomValues) crypto.getRandomValues(nb);
  const nonceHex = Array.from(nb, b => b.toString(16).padStart(2, '0')).join('');
  const header = { alg: 'EdDSA', kid: apiKeyId, typ: 'JWT', nonce: nonceHex };
  const payload = {
    sub: apiKeyId, iss: 'cdp', aud: ['cdp_service'],
    uris: [`${method} ${host}${path}`],
    iat: now, nbf: now, exp: now + 120,
  };
  const enc = o => b64url(_te.encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const sig = await subtle.sign('Ed25519', key, _te.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}
async function cdpAuthHeaders(env, method, url) {
  const id = env.CDP_API_KEY_ID;
  const secret = env.CDP_API_KEY_SECRET;
  if (!id || !secret) return {};
  const u = new URL(url);
  const token = await cdpJwt(id, secret, method, u.host, u.pathname);
  return { Authorization: `Bearer ${token}` };
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
// -- Direct on-chain payment verification (no facilitator) -----------------
// The client sends USDC directly to payTo, then passes ?txHash=. We verify
// the receipt on Base public RPC: confirmed + Transfer event of exactly the
// price to payTo on the USDC contract. No secrets, no hot wallet, no deps.

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BASE_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://1rpc.io/base',
];

// In-memory spent set. Note: serverless instances don't share memory, so a
// txHash could theoretically be reused across cold starts. Low volume makes
// this acceptable for now; a persistent store is the follow-up.
const spentTxHashes = new Set();

async function rpcFirst(urls, method, params) {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.result !== undefined) return j.result;
    } catch { /* try next RPC */ }
  }
  return null;
}

export async function verifyTxPayment(txHash, env) {
  const c = cfg(env);
  const hash = String(txHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'malformed tx hash' };
  if (spentTxHashes.has(hash)) return { ok: false, reason: 'payment already redeemed' };

  const receipt = await rpcFirst(BASE_RPC_URLS, 'eth_getTransactionReceipt', [hash]);
  if (!receipt) return { ok: false, reason: 'tx not found (or RPC unreachable)' };
  if (receipt.status !== '0x1') return { ok: false, reason: 'tx not successful' };

  const payTo = c.payTo.toLowerCase();
  const wantValue = priceInAtomicUnits(c.priceUsdc);
  const asset = c.asset.toLowerCase();

  for (const log of receipt.logs || []) {
    if (!log.address || log.address.toLowerCase() !== asset) continue;
    const topics = log.topics || [];
    if (!topics[0] || topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topics.length < 3) continue;
    const to = ('0x' + topics[2].slice(-40)).toLowerCase();
    let value;
    try { value = BigInt(log.data).toString(); } catch { continue; }
    if (to === payTo && value === wantValue) {
      spentTxHashes.add(hash);
      return { ok: true, txHash: hash };
    }
  }
  return { ok: false, reason: 'no matching USDC payment in tx logs' };
}
