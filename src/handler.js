// Runtime-agnostic request handler for token-risk-api.
// Used by src/server.js (Node) and worker.js (Cloudflare/Vercel Edge).
// All config comes from the `env` argument — no process.env reads here.

import { gatePayment, verifyTxPayment } from './payments/x402.js';
import { checkToken } from './sources/risk.js';
import { rateLimit } from './payments/ratelimit.js';

function json(status, body, headers = {}) {
  return { status, body, headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers } };
}

// Audit item #1: abuse guard. In paid mode, payment IS the throttle, so the
// limiter only applies to free/mock/test surfaces and as a coarse per-IP guard.
// Keyed by client IP (x-forwarded-for) or a fixed key when unidentifiable.
function clientKey(headers) {
  const fwd = headers && (headers['x-forwarded-for'] || headers['x-real-ip']);
  if (fwd) return 'ip:' + String(fwd).split(',')[0].trim();
  return 'unknown';
}

function applyRateLimit(env, headers, path) {
  // Paid mode: skip (payment throttles naturally). Free/mock/test: enforce.
  const mode = (env.PAYMENT_MODE || env.X402_MODE || 'live');
  if (mode === 'live') return null;
  const max = Number(env.RATE_LIMIT_MAX || 100);
  const windowMs = Number(env.RATE_LIMIT_WINDOW_MS || 60_000);
  const rl = rateLimit(`${clientKey(headers)}:${path}`, { max, windowMs });
  if (!rl.ok) {
    return json(429, { error: 'rate_limited', retryAfterMs: rl.retryAfterMs }, { 'retry-after': String(Math.ceil(rl.retryAfterMs / 1000)) });
  }
  return null;
}

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Token Risk API — Address in. Risk report out. $0.005 USDC.</title>
<meta name="description" content="Pay-per-call crypto token risk intelligence over x402 on Base. 0-100 risk score, A-F grade, market + contract security signals. No signup, no API key.">
<style>
:root{--bg:#0b0e14;--card:#131824;--line:#232c42;--txt:#e8ecf4;--mut:#9aa4bd;--acc:#4f8cff;--ok:#34d399;--warn:#fbbf24;--bad:#f87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}
.wrap{max-width:880px;margin:0 auto;padding:0 1.25rem}
header{padding:3.5rem 0 2rem;text-align:center}
h1{font-size:2.4rem;margin:.2em 0;line-height:1.15}
.tag{color:var(--acc);font-weight:700;letter-spacing:.02em}
.sub{color:var(--mut);font-size:1.1rem;max-width:36rem;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.5rem;margin:1.5rem 0}
h2{margin-top:0;font-size:1.3rem}
label{display:block;font-size:.85rem;color:var(--mut);margin:.6rem 0 .25rem}
input,select{width:100%;padding:.7rem .8rem;border-radius:8px;border:1px solid var(--line);background:#0d1220;color:var(--txt);font-size:1rem}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:.75rem 1.4rem;font-size:1rem;font-weight:700;cursor:pointer;margin-top:1rem}
button:hover{filter:brightness(1.1)}
button:disabled{opacity:.5;cursor:wait}
.row{display:flex;gap:.75rem;flex-wrap:wrap}.row>*{flex:1;min-width:200px}
#out{margin-top:1rem;font-size:.95rem}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem;word-break:break-all}
.paybox{background:#0d1220;border:1px dashed var(--acc);border-radius:10px;padding:1rem;margin-top:1rem}
.copy{background:#1c2438;color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:.3rem .7rem;font-size:.8rem;cursor:pointer;margin-left:.5rem}
.grade{display:inline-block;font-size:2.2rem;font-weight:800;border-radius:12px;padding:.1em .5em;margin-right:.6rem}
.gA{background:#064e3b;color:#6ee7b7}.gB{background:#1a3a2a;color:#a7f3d0}.gC{background:#3a2f10;color:#fde68a}.gD{background:#3a1f10;color:#fdba74}.gF{background:#3f1414;color:#fca5a5}
.score{font-size:2.2rem;font-weight:800}
ul.reasons{margin:.5rem 0;padding-left:1.2rem}ul.reasons li{margin:.25rem 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem;margin-top:.8rem}
.kv{background:#0d1220;border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem}.kv b{display:block;font-size:.75rem;color:var(--mut);font-weight:600}.kv span{font-size:.95rem}
pre{background:#0d1220;border:1px solid var(--line);border-radius:10px;padding:1rem;overflow:auto;font-size:.82rem}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem}
.step{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem}.step b{color:var(--acc)}
footer{color:var(--mut);font-size:.85rem;padding:2.5rem 0;text-align:center}
a{color:var(--acc)}.err{color:var(--bad)}.ok{color:var(--ok)}
.pill{display:inline-block;background:#0d1220;border:1px solid var(--line);border-radius:999px;padding:.25rem .8rem;font-size:.8rem;color:var(--mut);margin:.15rem}
</style>
</head>
<body>
<div class="wrap">

<header>
<div><span class="pill">LIVE ON BASE</span> <span class="pill">x402 PAY-PER-CALL</span> <span class="pill">NO SIGNUP</span></div>
<h1>Address in.<br>Risk report out. <span class="tag">$0.005 USDC.</span></h1>
<p class="sub">Token Risk API scores any crypto token 0–100 with an A–F grade — market signals (liquidity, volume, age) plus contract security (honeypot, hidden owner, mintable, taxes). Try it below. Every scan below is a real paid call.</p>
</header>

<div class="card" id="demo">
<h2>🛡️ Live demo — scan a token</h2>
<div class="row">
<div><label>Contract address or symbol</label><input id="token" placeholder="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"></div>
<div style="flex:0 0 160px"><label>Chain (optional)</label><select id="chain"><option value="">auto-detect</option><option>base</option><option>ethereum</option><option>bsc</option><option>polygon</option><option>arbitrum</option><option>optimism</option><option>avalanche</option><option>solana</option></select></div>
</div>
<button id="scanBtn" onclick="startScan()">Scan — $0.005 USDC</button>
<div id="out"></div>
</div>

<div class="card">
<h2>How it works</h2>
<div class="steps">
<div class="step"><b>1. Request</b><br>Your app or agent calls <span class="mono">GET /v1/risk?token=0x…</span>. No key, no account.</div>
<div class="step"><b>2. Pay $0.005</b><br>Server answers <span class="mono">402</span> with payment requirements. Send 0.005 USDC on Base — direct transfer, no facilitator needed.</div>
<div class="step"><b>3. Get the report</b><br>Retry with your tx hash. Score, grade, itemized reasons, market + security data. Done in seconds.</div>
</div>
</div>

<div class="card">
<h2>For agents (x402)</h2>
<p>Machine clients use the standard x402 flow — the <span class="mono">PAYMENT-REQUIRED</span> header carries everything needed:</p>
<pre>import { createX402Fetch } from "@x402/fetch";
const xfetch = createX402Fetch(); // pays + retries automatically
const res = await xfetch(
  "https://token-risk-api-topaz.vercel.app/v1/risk?token=" + contractAddress
);
const report = await res.json(); // { risk: { score, grade, reasons }, ... }</pre>
<p>Or pay manually: send <b>0.005 USDC</b> (Base) to the address in the 402 response, then call <span class="mono">/v1/risk?token=0x…&amp;txHash=0x…</span></p>
</div>

<div class="card">
<h2>Pricing</h2>
<p style="font-size:1.6rem;font-weight:800;margin:.2em 0">$0.005 <span style="font-size:1rem;color:var(--mut)">USDC per call, on Base</span></p>
<p class="sub" style="text-align:left;margin:0">No subscription. No tiers. No API key. 200 paid calls cost $1.</p>
</div>

<div class="card">
<h2>Endpoints</h2>
<pre>GET /health                        service status
GET /v1/risk?token=0x…[&amp;chain=base]   risk report (402 → pay → retry with &amp;txHash=0x…)</pre>
<p>Batch: <span class="mono">POST /v1/risk/batch</span> with <span class="mono">{"tokens":["0x…"],"chain":"base"}</span> (see repo docs).</p>
</div>

<footer>
<p><b>Not financial advice.</b> Informational risk assessment only — scores can be wrong or manipulated upstream. Always do your own due diligence.</p>
<p><a href="https://rugshield-xi.vercel.app">rugshield — "scan before you ape"</a> · <a href="https://github.com/prayingperceptions/token-risk-api">GitHub</a> · <a href="/health">API status</a></p>
<p>MIT licensed · Built by <a href="https://github.com/prayingperceptions">prayingperceptions</a></p>
</footer>

</div>
<script>
var pendingToken = "", pendingChain = "";
function el(id){ return document.getElementById(id); }
function out(html){ el("out").innerHTML = html; }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function copyTx(t){ navigator.clipboard.writeText(t).then(function(){ out(el("out").innerHTML + '<p class="ok">Copied.</p>'); }); }

async function startScan(){
  var token = el("token").value.trim(), chain = el("chain").value;
  if(!token){ out('<p class="err">Enter a contract address or token symbol first.</p>'); return; }
  el("scanBtn").disabled = true;
  out("<p>Requesting risk report…</p>");
  try{
    var url = "/v1/risk?token=" + encodeURIComponent(token) + (chain ? "&chain=" + encodeURIComponent(chain) : "");
    var r = await fetch(url);
    if(r.status === 200){ renderReport(await r.json()); return; }
    if(r.status === 402){
      var body = await r.json();
      var acc = (body.accepts && body.accepts[0]) || {};
      pendingToken = token; pendingChain = chain;
      var atomic = acc.amount || "5000";
      var usdc = (parseInt(atomic,10)/1e6).toFixed(6).replace(/0+$/,"").replace(/\.$/,"");
      var payTo = acc.payTo || "(see 402 response)";
      out('<div class="paybox"><b>Payment required — $' + esc(usdc) + ' USDC on Base</b><br>' +
        'Send exactly <b>' + esc(usdc) + ' USDC</b> to:<br><span class="mono">' + esc(payTo) + '</span>' +
        '<button class="copy" onclick="copyTx(\'' + esc(payTo) + '\')">copy</button><br><br>' +
        '<label>Transaction hash (0x…)</label><input id="txhash" placeholder="0x…">' +
        '<button onclick="submitTx()">Verify payment &amp; get report</button>' +
        '<p style="color:var(--mut);font-size:.85rem">Payments are verified on-chain via Base RPC. Wait ~10s after sending, then verify.</p></div>');
      return;
    }
    out('<p class="err">Error ' + r.status + ': ' + esc((await r.text()).slice(0,300)) + '</p>');
  }catch(e){ out('<p class="err">Request failed: ' + esc(e.message) + '</p>'); }
  el("scanBtn").disabled = false;
}

async function submitTx(){
  var tx = el("txhash").value.trim();
  if(!tx){ out('<p class="err">Paste the transaction hash first.</p>'); return; }
  out("<p>Verifying payment on-chain…</p>");
  try{
    var url = "/v1/risk?token=" + encodeURIComponent(pendingToken) + "&txHash=" + encodeURIComponent(tx) +
      (pendingChain ? "&chain=" + encodeURIComponent(pendingChain) : "");
    var r = await fetch(url);
    var body = await r.json();
    if(r.status === 200){ renderReport(body); return; }
    out('<p class="err">Payment not verified yet: ' + esc(body.reason || body.error || ("HTTP "+r.status)) + '. Wait a few seconds for confirmation, then try again.</p>' +
      '<button onclick="submitTx()">Retry verification</button>');
  }catch(e){ out('<p class="err">Request failed: ' + esc(e.message) + '</p>'); }
  el("scanBtn").disabled = false;
}

function renderReport(d){
  el("scanBtn").disabled = false;
  var risk = d.risk || {}, t = d.token || {}, m = d.market || {}, s = d.contractSecurity || {};
  var g = (risk.grade || "?").toUpperCase();
  var reasons = (risk.reasons || []).map(function(x){ return "<li>" + esc(x) + "</li>"; }).join("") || "<li>No red flags itemized.</li>";
  var secs = [];
  if(s.isHoneypot === true) secs.push(["Honeypot", "YES"]);
  if(s.isHoneypot === false) secs.push(["Honeypot", "no"]);
  if(s.isMintable != null) secs.push(["Mintable", s.isMintable ? "yes" : "no"]);
  if(s.isOpenSource != null) secs.push(["Open source", s.isOpenSource ? "yes" : "no"]);
  var secHtml = secs.map(function(kv){ return '<div class="kv"><b>' + esc(kv[0]) + '</b><span>' + esc(kv[1]) + "</span></div>"; }).join("");
  var txLine = (d.payment && d.payment.txHash) ? '<p style="color:var(--mut);font-size:.85rem">Paid · <span class="mono">' + esc(d.payment.txHash).slice(0,18) + '…</span></p>' : "";
  out('<div><span class="grade g' + esc(g) + '">' + esc(g) + '</span>' +
    '<span class="score">' + esc(risk.score) + '<span style="font-size:1rem;color:var(--mut)">/100</span></span> ' +
    '<b>' + esc(t.name || "") + '</b> <span style="color:var(--mut)">' + esc(t.symbol || "") + '</span></div>' +
    '<ul class="reasons">' + reasons + '</ul>' +
    '<div class="grid">' +
    '<div class="kv"><b>Liquidity</b><span>$' + esc(m.liquidityUsd != null ? Number(m.liquidityUsd).toLocaleString() : "?") + '</span></div>' +
    '<div class="kv"><b>24h volume</b><span>$' + esc(m.volume24h != null ? Number(m.volume24h).toLocaleString() : "?") + '</span></div>' +
    '<div class="kv"><b>Chain</b><span>' + esc(m.chainId || m.chain || "?") + '</span></div>' + secHtml + '</div>' +
    '<p style="color:var(--mut);font-size:.85rem">Checked ' + esc(d.checkedAt || "") + '</p>' + txLine +
    '<button onclick="startScan()">Scan another token</button>');
}
</script>
</body>
</html>
`;

function landingPage() {
  return {
    status: 200,
    body: LANDING_HTML,
    headers: { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' },
  };
}

export async function handle(req, env) {
  const { method, headers } = req;

  // Vercel may invoke /api/index.js directly or include function path prefixes.
  let path = req.path;
  if (typeof path === 'string') {
    path = path.replace(/^\/api\/index\.js/, '').replace(/\/$/, '') || '/';
  }

  let query = req.query;

  // CORS preflight: browser clients send OPTIONS before the paid retry
  // (custom X-PAYMENT header). Answer it or the preflight fails and the
  // browser reports a bare 'Failed to fetch'.
  if (method === 'OPTIONS') {
    return {
      status: 204,
      body: {},
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'X-PAYMENT, Content-Type',
        'access-control-max-age': '86400',
      },
    };
  }

  if (method !== 'GET') return json(405, { error: 'method_not_allowed' });

  // FAIL-CLOSED: /debug is only enabled when ALLOW_DEBUG env is explicit; never
  // exposed by default in production (it leaks config).
  if (path === '/debug') {
    if (env.ALLOW_DEBUG !== 'true' && !(env.NODE_ENV === 'development')) {
      return json(404, { error: 'not found' });
    }
    return json(200, {
      debug: true,
      rawPath: req.path,
      normalizedPath: path,
      query: query && (typeof query.get === 'function' ? Object.fromEntries(query) : query),
      paymentMode: env.PAYMENT_MODE || 'live',
    });
  }

  if (path === '/health') {
    return json(200, {
      ok: true,
      service: 'token-risk-api',
      version: '0.1.0',
      paymentMode: env.PAYMENT_MODE || 'live',
      priceUsdc: env.PRICE_USDC || '0.005',
      network: env.X402_NETWORK || 'eip155:8453',
    });
  }

  // Landing page for browsers; API clients (Accept: application/json or */*)
  // keep getting the JSON status for backwards compatibility.
  if (path === '/') {
    const accept = (headers && headers['accept']) || '';
    if (typeof accept === 'string' && accept.includes('text/html')) return landingPage();
    return json(200, {
      ok: true,
      service: 'token-risk-api',
      version: '0.1.0',
      paymentMode: env.PAYMENT_MODE || 'live',
      priceUsdc: env.PRICE_USDC || '0.005',
      network: env.X402_NETWORK || 'eip155:8453',
    });
  }

  if (path === '/v1/risk') {
    const token = query && typeof query.get === 'function' ? query.get('token') : (query && query.token);
    const chain = query && typeof query.get === 'function' ? query.get('chain') : (query && query.chain);
    if (!token) return json(400, { error: 'missing required query param: token' });

    const limited = applyRateLimit(env, headers, path);
    if (limited) return limited;

    // Direct on-chain payment: ?txHash=0x... verified against Base RPC.
    // No facilitator, no signature — the Transfer event is the receipt.
    const txHash = query && typeof query.get === 'function' ? query.get('txHash') : (query && query.txHash);
    if (txHash) {
      const v = await verifyTxPayment(txHash, env);
      if (!v.ok) {
        return json(402, { error: 'payment not verified', reason: v.reason });
      }
      try {
        const report = await checkToken(token, chain, fetch);
        return json(200, { ...report, payment: { txHash: v.txHash } });
      } catch (err) {
        return json(500, { error: 'risk check failed', detail: String(err && err.message || err) });
      }
    }

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
