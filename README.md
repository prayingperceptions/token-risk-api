# Token Risk API 🛡️

**Pay-per-call crypto token risk intelligence.**

> **Know what you're buying before you buy it.**

**Address in. Risk report out. $0.005 USDC.**

Token Risk API is a zero-dependency Node.js service that aggregates live market data and contract security signals into a transparent, actionable risk score — sold over x402 at a fraction of a cent per call.

---

## ⚡ Quick Start

```bash
git clone https://github.com/prayingperceptions/token-risk-api.git
cd token-risk-api
npm start
```

Test it:

```bash
curl "http://localhost:3402/v1/risk?token=***"
curl "http://localhost:3402/v1/risk?token=***"
```

No API key, no signup, no account required. Pay per call over x402.

---

## 🧭 The Model

Trading agents and DeFi users need to answer one question fast:

> **Is this token a scam, a ghost town, or a real market?**

```text
                    ┌─────────────┐
                    │   QUERY     │
                    │ address or  │
                    │   symbol    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  MARKET     │
                    │  Dexscreener│
                    │ liquidity   │
                    │ volume, age │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  CONTRACT   │
                    │   GoPlus    │
                    │ honeypot,   │
                    │ mintable,   │
                    │ hidden owner│
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   SCORE     │
                    │  0–100 +    │
                    │  A–F grade  │
                    │  + reasons  │
                    └─────────────┘
```

Transparent scoring. Every point itemized. No black boxes.

---

## 📊 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service status and config |
| `GET` | `/v1/risk?token=***<query>[&chain=<chain>]` | Full risk report |

**Query options:**
- `token` — contract address (EVM or Solana) or symbol search
- `chain` — optional chain hint (ethereum, bsc, polygon, arbitrum, base, optimism, avalanche, solana)

**Response:**

```json
{
  "query": "0x833...",
  "checkedAt": "2026-09-23T01:28:41.659Z",
  "token": {
    "address": "0x833...",
    "name": "USD Coin",
    "symbol": "USDC"
  },
  "risk": {
    "score": 0,
    "grade": "A",
    "reasons": []
  },
  "market": {
    "chainId": "base",
    "liquidityUsd": 145613.32,
    "volume24h": 52307.01,
    ...
  },
  "contractSecurity": {
    "isHoneypot": false,
    "isOpenSource": true,
    "isMintable": null,
    ...
  }
}
```

---

## 🔧 Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3402` | Listen port |
| `PAYMENT_MODE` | `mock` | `mock` (free testing) or `live` (x402 v2) |
| `PRICE_USDC` | `0.005` | Price per call |
| `X402_PAY_TO` | `0x2091…5DeA` | Receiving address (Base mainnet USDC) |
| `X402_NETWORK` | `eip155:8453` | Payment network (Base mainnet) |
| `X402_ASSET` | USDC Base mainnet | Canonical USDC contract address |
| `X402_FACILITATOR_URL` | Coinbase CDP | Mainnet facilitator (testnet `x402.org/facilitator` is NOT for mainnet) |

**Live:** `https://token-risk-api-topaz.vercel.app` — x402 v2, Base mainnet, $0.005 USDC/call.

---

## 🚀 Deployment

### Vercel (recommended)

1. Import this repo to Vercel
2. Set environment variables in project settings
3. Deploy — auto-scales, zero config

### Cloudflare Workers

```bash
wrangler deploy
```

### Plain Node

```bash
node src/server.js
```

---

## 🧪 Testing

```bash
npm test
```

Runs 7 end-to-end checks against live public data sources.

---

## 📄 License

MIT
