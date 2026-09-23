// token-risk-api HTTP server (plain Node, zero dependencies).
// Endpoints:
//   GET  /health                     -> { ok: true, mode }
//   GET  /v1/risk?token=<q>[&chain=<c>]  -> x402-gated risk report
import http from "node:http";
import { gatePayment, x402Config } from "./x402.js";
import { checkToken } from "./risk.js";

const PORT = parseInt(process.env.PORT || "3402", 10);

function send(res, status, obj, extraHeaders = {}) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "token-risk-api", version: "0.1.0", x402Mode: x402Config.mode, priceUsdc: x402Config.priceUsdc, network: x402Config.network });
  }

  if (url.pathname === "/v1/risk") {
    const token = url.searchParams.get("token");
    const chain = url.searchParams.get("chain");
    if (!token) return send(res, 400, { error: "missing required query param: token" });

    const resourceUrl = url.pathname + url.search;
    let gate;
    try {
      gate = await gatePayment(req, resourceUrl);
    } catch (err) {
      return send(res, 502, { error: "payment verification failed", detail: String(err) });
    }
    if (!gate.paid) {
      return send(res, gate.status, gate.body, gate.headers);
    }

    try {
      const report = await checkToken(token, chain);
      return send(res, 200, { ...report, payment: gate.mode ? { mode: gate.mode } : { txHash: gate.txHash || null } });
    } catch (err) {
      return send(res, 500, { error: "risk check failed", detail: String(err) });
    }
  }

  return send(res, 404, { error: "not found", endpoints: ["/health", "/v1/risk?token=<query>&chain=<chain?>"] });
});

server.listen(PORT, () => {
  console.log(`token-risk-api listening on :${PORT} (x402 mode=${x402Config.mode}, price=${x402Config.priceUsdc} USDC)`);
});
