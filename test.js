// End-to-end local test in mock x402 mode against live public data sources.
// Usage: X402_MODE=mock node test.js
import { spawn } from "node:child_process";

const PORT = 3412;
const BASE = `http://127.0.0.1:${PORT}`;

function request(path) {
  return new Promise((resolve, reject) => {
    fetch(BASE + path).then(async (res) => {
      resolve({ status: res.status, body: await res.json() });
    }).catch(reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT), X402_MODE: "mock" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));

await sleep(1200);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} :: ${detail}`); }
};

try {
  const health = await request("/health");
  check("health endpoint", health.status === 200 && health.body.ok === true, JSON.stringify(health));

  // USDC on Base (well-known address) via contract-address path.
  const usdcBase = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const byAddr = await request(`/v1/risk?token=${usdcBase}`);
  check("risk by address returns 200", byAddr.status === 200, JSON.stringify(byAddr).slice(0, 300));
  check("risk report has score+grade", typeof byAddr.body?.risk?.score === "number" && typeof byAddr.body?.risk?.grade === "string", JSON.stringify(byAddr.body?.risk));
  check("risk report identifies token", byAddr.body?.token?.symbol != null, JSON.stringify(byAddr.body?.token));
  check("payment marked mock", byAddr.body?.payment?.mode === "mock", JSON.stringify(byAddr.body?.payment));

  // Symbol search path.
  const bySym = await request(`/v1/risk?token=WETH`);
  check("risk by symbol returns 200", bySym.status === 200, JSON.stringify(bySym).slice(0, 300));

  const missing = await request("/v1/risk");
  check("missing token -> 400", missing.status === 400, JSON.stringify(missing));

  console.log(`\nSample report (USDC on Base):\n${JSON.stringify(byAddr.body, null, 2).slice(0, 2000)}`);
} finally {
  server.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
