// x402 payment-gating middleware (framework-agnostic Node).
// Live mode follows the x402 protocol: respond 402 with payment requirements,
// accept an X-PAYMENT header carrying a signed payment payload, verify via a
// facilitator, then settle. Mock mode short-circuits for local testing.
//
// Config via env:
//   X402_MODE=mock|live          (default mock)
//   X402_PRICE_USDC=0.005
//   X402_PAY_TO=0x...            (receiving address, Base)
//   X402_FACILITATOR_URL=https://x402.org/facilitator  (go-live checklist item)
//   X402_NETWORK=base

const config = {
  mode: process.env.X402_MODE || "mock",
  priceUsdc: process.env.X402_PRICE_USDC || "0.005",
  payTo: process.env.X402_PAY_TO || "0x0000000000000000000000000000000000000000",
  facilitatorUrl: process.env.X402_FACILITATOR_URL || "",
  network: process.env.X402_NETWORK || "base",
};

const USDC_BASE_DECIMALS = 6;

function priceInAtomicUnits() {
  return String(Math.round(parseFloat(config.priceUsdc) * 10 ** USDC_BASE_DECIMALS));
}

// x402 V1-style payment requirements object returned with HTTP 402.
export function paymentRequirements(resourceUrl) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        maxAmountRequired: priceInAtomicUnits(),
        resource: resourceUrl,
        description: "Token risk check",
        mimeType: "application/json",
        payTo: config.payTo,
        asset: "USDC",
        maxTimeoutSeconds: 60,
      },
    ],
    error: "Payment required",
  };
}

async function verifyWithFacilitator(paymentHeader, resourceUrl) {
  // Standard x402 facilitator flow: POST /verify then settle on success.
  // Requires X402_FACILITATOR_URL. See README go-live checklist.
  const requirements = paymentRequirements(resourceUrl).accepts[0];
  const res = await fetch(`${config.facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentHeader, paymentRequirements: requirements }),
  });
  if (!res.ok) return { ok: false, reason: `facilitator verify HTTP ${res.status}` };
  const body = await res.json();
  if (!body.isValid) return { ok: false, reason: body.invalidReason || "invalid payment" };

  const settle = await fetch(`${config.facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentHeader, paymentRequirements: requirements }),
  });
  if (!settle.ok) return { ok: false, reason: `facilitator settle HTTP ${settle.status}` };
  const settled = await settle.json();
  if (!settled.success) return { ok: false, reason: settled.error || "settlement failed" };
  return { ok: true, txHash: settled.txHash || null };
}

// Returns { paid: true } or { paid: false, status, headers, body } to send.
export async function gatePayment(req, resourceUrl) {
  if (config.mode === "mock") {
    return { paid: true, mode: "mock" };
  }
  const paymentHeader = req.headers["x-payment"];
  if (!paymentHeader) {
    return {
      paid: false,
      status: 402,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(paymentRequirements(resourceUrl)),
    };
  }
  const verdict = await verifyWithFacilitator(paymentHeader, resourceUrl);
  if (!verdict.ok) {
    return {
      paid: false,
      status: 402,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...paymentRequirements(resourceUrl), error: verdict.reason }),
    };
  }
  return { paid: true, txHash: verdict.txHash };
}

export { config as x402Config };
