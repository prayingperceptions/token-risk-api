// Token risk aggregation from free public data sources — runtime-agnostic.
// fetch is passed in so this runs in Node and in Workers/Edge.

const DEXSCREENER_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/";
const DEXSCREENER_SEARCH = "https://api.dexscreener.com/latest/dex/search?q=";
const GOPLUS = "https://api.gopluslabs.io/api/v1/token_security/";

const TIMEOUT_MS = 8000;

const CHAIN_IDS = {
  ethereum: "1", eth: "1",
  bsc: "56", bnb: "56",
  polygon: "137", matic: "137",
  arbitrum: "42161",
  base: "8453",
  optimism: "10",
  avalanche: "43114", avax: "43114",
  solana: "solana", sol: "solana",
};

async function fetchJson(fetchFn, url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: ctrl.signal, headers: { "User-Agent": "token-risk-api/0.1" } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err && err.name === "AbortError" ? "timeout" : err) };
  } finally {
    clearTimeout(timer);
  }
}

function isAddress(q) {
  return /^0x[a-fA-F0-9]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
}

async function fromDexscreener(fetchFn, query) {
  const url = isAddress(query) ? DEXSCREENER_TOKENS + query : DEXSCREENER_SEARCH + encodeURIComponent(query);
  const res = await fetchJson(fetchFn, url);
  if (!res.ok) return { ok: false, source: "dexscreener", error: res.error || `HTTP ${res.status}` };
  const pairs = res.data && Array.isArray(res.data.pairs) ? res.data.pairs : [];
  if (!pairs.length) return { ok: false, source: "dexscreener", error: "no pairs found" };
  const queryNorm = query.trim().toLowerCase();
  // Identify WHICH side of each pair is the queried token. When the query is an
  // address, restrict to pairs where that address is the base token; falling
  // back to quote-token matches would silently report on the wrong asset.
  const baseMatches = pairs.filter((p) => (p.baseToken?.address || "").toLowerCase() === queryNorm);
  const symMatches = pairs.filter((p) => (p.baseToken?.symbol || "").toLowerCase() === queryNorm);
  let candidates = pairs;
  if (isAddress(query) && baseMatches.length) candidates = baseMatches;
  else if (!isAddress(query) && symMatches.length) candidates = symMatches;
  candidates.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = candidates[0];
  return {
    ok: true,
    source: "dexscreener",
    chainId: p.chainId || null,
    token: {
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

async function fromGoPlus(fetchFn, address, chainId) {
  if (!address || !chainId || chainId === "solana") {
    return { ok: false, source: "goplus", error: "unsupported chain or missing address" };
  }
  const res = await fetchJson(fetchFn, `${GOPLUS}${chainId}?contract_addresses=${address}`);
  if (!res.ok) return { ok: false, source: "goplus", error: res.error || `HTTP ${res.status}` };
  const r = res.data && res.data.result && res.data.result[address.toLowerCase()];
  if (!r) return { ok: false, source: "goplus", error: "no result for address" };
  const pct = (x) => (x == null ? null : parseFloat(x) * 100);
  const holders = Array.isArray(r.holders) ? r.holders : [];
  const top10Pct = holders.length
    ? holders.slice(0, 10).reduce((s, h) => s + (parseFloat(h.percent) || 0), 0) * 100
    : null;
  const flag = (v) => (v === "1" ? true : v === "0" ? false : null);
  return {
    ok: true,
    source: "goplus",
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
    if (dex.liquidityUsd == null || dex.liquidityUsd < 10_000) add(30, `very low liquidity ($${dex.liquidityUsd ?? "unknown"})`);
    else if (dex.liquidityUsd < 50_000) add(15, `low liquidity ($${Math.round(dex.liquidityUsd)})`);
    if (dex.volume24h != null && dex.volume24h < 5_000) add(15, `thin 24h volume ($${Math.round(dex.volume24h)})`);
    if (dex.pairCreatedAt) {
      const ageDays = (Date.now() - new Date(dex.pairCreatedAt).getTime()) / 86400000;
      if (ageDays < 7) add(15, `pair only ${ageDays.toFixed(1)} days old`);
    }
  } else {
    add(25, "market data unavailable");
  }

  if (gp.ok) {
    if (gp.isHoneypot) add(60, "honeypot flag");
    if (gp.selfDestruct) add(40, "self-destruct present");
    if (gp.hiddenOwner) add(20, "hidden owner");
    if (gp.ownerChangeBalance) add(20, "owner can change balances");
    if (gp.isMintable) add(10, "mintable supply");
    if (gp.isOpenSource === false) add(10, "contract not open source");
    if (gp.sellTaxPct != null && gp.sellTaxPct > 10) add(20, `high sell tax ${gp.sellTaxPct.toFixed(1)}%`);
    if (gp.buyTaxPct != null && gp.buyTaxPct > 10) add(10, `high buy tax ${gp.buyTaxPct.toFixed(1)}%`);
    if (gp.top10HolderPct != null && gp.top10HolderPct > 50) add(15, `top 10 holders own ${gp.top10HolderPct.toFixed(0)}%`);
  }

  score = Math.min(100, score);
  const grade = score >= 60 ? "F" : score >= 40 ? "D" : score >= 25 ? "C" : score >= 10 ? "B" : "A";
  return { score, grade, reasons };
}

export async function checkToken(query, chainHint, fetchFn) {
  const f = fetchFn || fetch;
  const dex = await fromDexscreener(f, query);
  let gp = { ok: false, source: "goplus", error: "skipped" };
  const chainId = chainHint
    ? CHAIN_IDS[chainHint.toLowerCase()] || null
    : (dex.ok ? CHAIN_IDS[dex.chainId] || null : null);
  if (dex.ok && dex.token.address && chainId) {
    gp = await fromGoPlus(f, dex.token.address, chainId);
  }
  const risk = scoreRisk(dex, gp);
  return {
    query,
    checkedAt: new Date().toISOString(),
    token: dex.ok ? dex.token : null,
    risk,
    market: dex.ok ? {
      chainId: dex.chainId, liquidityUsd: dex.liquidityUsd, volume24h: dex.volume24h,
      priceUsd: dex.priceUsd, fdv: dex.fdv, txns24h: dex.txns24h,
      priceChange24hPct: dex.priceChange24hPct, pairCreatedAt: dex.pairCreatedAt,
      dexId: dex.dexId, url: dex.dexscreenerUrl,
    } : null,
    contractSecurity: gp.ok ? gp : null,
    sources: [
      { name: "dexscreener", ok: dex.ok, error: dex.ok ? undefined : dex.error },
      { name: "goplus", ok: gp.ok, error: gp.ok ? undefined : gp.error },
    ],
  };
}
