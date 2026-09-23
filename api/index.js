// token-risk-api — single-file Vercel serverless function.
// Self-contained: x402 payment gate + Dexscreener/GoPlus risk aggregation.
// No external dependencies. Zero local imports. Drop this into api/index.js.

const USDC_BASE_DECIMALS = 6;
const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens/';
const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/search?q=';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security/';
const TIMEOUT_MS = 8000;

const CHAIN_IDS = {
  ethereum: '1', eth: '1',
  bsc: '56', bnb: '56',
  polygon: '137', matic: '137',
  arbitrum: '42161',
  base: '8453',
  optimism: '10',
  avalanche: '43114', avax: '43114',
  solana: 'solana', sol: 'solana',
};

function json(status, body, headers = {}) {
  return { status, body, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } };
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'token-risk-api/0.1' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err && err.name === 'AbortError' ? 'timeout' : err) };
  } finally {
    clearTimeout(timer);
  }
}

function isAddress(q) {
  return /^0x[a-fA-F0-9]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
}

async function fromDexscreener(query) {
  const url = isAddress(query) ? DEXSCREENER_TOKENS + query : DEXSCREENER_SEARCH + encodeURIComponent(query);
  const res = await fetchJson(url);
  if (!res.ok) return { ok: false, source: 'dexscreener', error: res.error || `HTTP ${res.status}` };
  const pairs = res.data && Array.isArray(res.data.pairs) ? res.data.pairs : [];
  if (!pairs.length) return { ok: false, source: 'dexscreener', error: 'no pairs found' };
  const queryNorm = query.trim().toLowerCase();
  const baseMatches = pairs.filter((p) => (p.baseToken?.address || '').toLowerCase() === queryNorm);
  const symMatches = pairs.filter((p) => (p.baseToken?.symbol || '').toLowerCase() === queryNorm);
  let candidates = pairs;
  if (isAddress(query) && baseMatches.length) candidates = baseMatches;
  else if (!isAddress(query) && symMatches.length) candidates = symMatches;
  candidates.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = candidates[0];
  return {
    ok: true,
    source: 'dexscreener',
    chainId: p.chainId || null,
    token: ***
      address: p.baseToken?.address || null,
      name: p.baseToken?.name || null,
      symbol: p.baseToken?.symbol || null,
    },
    liquidityUsd: p.liquidity?.usd ?? null,
    volume24h: p.volume?.h24 ?? null,
    priceUsd: p.priceUsd ? parseFloat(p.priceUsd) : null,
    fdv: p.fdv ?? null,
    pairAddress: p.pairAddress || null,
    dexId: p.dexId || null,
    pairCreatedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
    txns24h: p.txns?.h24 ? { buys: p.txns.h24.buys, sells: p.txns.h24.sells } : null,
    priceChange24hPct: p.priceChange?.h24 ?? null,
    dexscreenerUrl: p.url || null,
  };
}

async function fromGoPlus(address, chainId) {
  if (!address || !chainId || chainId === 'solana') {
    return { ok: false, source: 'goplus', error: 'unsupported chain or missing address' };
  }
  const res = await fetchJson(`${GOPLUS}${chainId}?contract_addresses=${address}`);
  if (!res.ok) return { ok: false, source: 'goplus', error: res.error || `HTTP ${res.status}` };
  const r = res.data && res.data.result && res.data.result[address.toLowerCase()];
  if (!r) return { ok: false, source: 'goplus', error: 'no result for address' };
  const pct = (x) => (x == null ? null : parseFloat(x) * 100);
  const holders = Array.isArray(r.holders) ? r.holders : [];
  const top10Pct = holders.length
    ? holders.slice(0, 10).reduce((s, h) => s + (parseFloat(h.percent) || 0), 0) * 100
    : null;
  const flag = (v) => (v === '1' ? true : v === '0' ? false : null);
  return {
    ok: true,
    source: 'goplus',
    isHoneypot: flag(r.is_honeypot),
    isOpenSource: flag(r.is_open_source),
    isProxy: flag(r.is_proxy),
    isMintable: flag(r.is_mintable),
    canTakeBackOwnership: flag(r.can_take_back_ownership),
    ownerChangeBalance: flag(r.owner_change_balance),
    hiddenOwner: flag(r.hidden_owner),
    selfDestruct: flag(r.selfdestruct),
    externalCall: flag(r.external_call),
    buyTaxPct: pct(r.buy_tax),
    sellTaxPct: pct(r.sell_tax),
    holderCount: r.holder_count ? parseInt(r.holder_count, 10) : null,
    top10HolderPct: top10Pct,
    isInDex: flag(r.is_in_dex),
  };
}

function scoreRisk(dex, gp) {
  let score = 0;
  const reasons = [];
  const add = (pts, reason) => { score += pts; reasons.push(`+${pts}: ${reason}`); };

  if (dex.ok) {
    if (dex.liquidityUsd == null || dex.liquidityUsd < 10_000) add(30, `very low liquidity ($${dex.liquidityUsd ?? 'unknown'})`);
    else if (dex.liquidityUsd < 50_000) add(15, `low liquidity ($${Math.round(dex.liquidityUsd)})`);
    if (dex.volume24h != null && dex.volume24h < 5_000) add(15, `thin 24h volume ($${Math.round(dex.volume24h)})`);
    if (dex.pairCreatedAt) {
      const ageDays = (Date.now() - new Date(dex.pairCreatedAt).getTime()) / 86400000;
      if (ageDays < 7) add(15, `pair only ${ageDays.toFixed(1)} days old`);
    }
  } else {
    add(25, 'market data unavailable');
  }

  if (gp.ok) {
    if (gp.isHoneypot) add(60, 'honeypot flag');
    if (gp.selfDestruct) add(40, 'self-destruct present');
    if (gp.hiddenOwner) add(20, 'hidden owner');
    if (gp.ownerChangeBalance) add(20, 'owner can change balances');
    if (gp.isMintable) add(10, 'mintable supply');
    if (gp.isOpenSource === false) add(10, 'contract not open source');
    if (gp.sellTaxPct != null && gp.sellTaxPct > 10) add(20, `high sell tax ${gp.sellTaxPct.toFixed(1)}%`);
    if (gp.buyTaxPct != null && gp.buyTaxPct > 10) add(10, `high buy tax ${gp.buyTaxPct.toFixed(1)}%`);
    if (gp.top10HolderPct != null && gp.top10HolderPct > 50) add(15, `top 10 holders own ${gp.top10HolderPct.toFixed(0)}%`);
  }

  score = Math.min(100, score);
  const grade = score >= 60 ? 'F' : score >= 40 ? 'D' : score >= 25 ? 'C' : score >= 10 ? 'B' : 'A';
  return { score, grade, reasons };
}

async function checkToken(query, chainHint) {
  const dex = await fromDexscreener(query);
  let gp = { ok: false, source: 'goplus', error: 'skipped' };
  const chainId = chainHint
    ? CHAIN_IDS[chainHint.toLowerCase()] || null
    : (dex.ok ? CHAIN_IDS[dex.chainId] || null : null);
  if (dex.ok && dex.token.address && chainId) {
    gp = await fromGoPlus(dex.token.address, chainId);
  }
  const risk = scoreRisk(dex, gp);
  return {
    query,
    checkedAt: new Date().toISOString(),
    token: *** ? dex.token : ***,
    risk,
    market: dex.ok ? {
      chainId: dex.chainId, liquidityUsd: dex.liquidityUsd, volume24h: dex.volume24h,
      priceUsd: dex.priceUsd, fdv: dex.fdv, txns24h: dex.txns24h,
      priceChange24hPct: dex.priceChange24hPct, pairCreatedAt: dex.pairCreatedAt,
      dexId: dex.dexId, url: dex.dexscreenerUrl,
    } : null,
    contractSecurity: gp.ok ? gp : null,
    sources: [
      { name: 'dexscreener', ok: dex.ok, error: dex.ok ? undefined : dex.error },
      { name: 'goplus', ok: gp.ok, error: gp.ok ? undefined : gp.error },
    ],
  };
}

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

function paymentRequirements(resourceUrl, env) {
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

async function gatePayment(req, resourceUrl, env) {
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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);

  const send = (status, body) => {
    res.status(status).json(body);
  };

  if (url.pathname === '/debug') {
    send(200, {
      debug: true,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      paymentMode: cfg(process.env).mode,
      payTo: cfg(process.env).payTo,
    });
    return;
  }

  if (url.pathname === '/health' || url.pathname === '/') {
    send(200, {
      ok: true,
      service: 'token-risk-api',
      version: '0.1.0',
      paymentMode: cfg(process.env).mode,
      priceUsdc: cfg(process.env).priceUsdc,
      network: cfg(process.env).network,
    });
    return;
  }

  if (url.pathname === '/v1/risk') {
    const token = url.searchParams.get('token');
    const chain = url.searchParams.get('chain');
    if (!token) {
      send(400, { error: 'missing required query param: token' });
      return;
    }

    let gate;
    try {
      gate = await gatePayment({ headers }, url.toString(), process.env);
    } catch (err) {
      send(502, { error: 'payment verification failed', detail: String(err && err.message || err) });
      return;
    }
    if (!gate.paid) {
      res.status(gate.status).set(gate.headers).end(gate.body);
      return;
    }

    try {
      const report = await checkToken(token, chain);
      send(200, { ...report, payment: gate.mode ? { mode: gate.mode } : { txHash: gate.txHash || null } });
    } catch (err) {
      send(500, { error: 'risk check failed', detail: String(err && err.message || err) });
    }
    return;
  }

  send(404, { error: 'not found', endpoints: ['/health', '/v1/risk?token=***<query>&chain=<chain?>', '/debug'] });
}
