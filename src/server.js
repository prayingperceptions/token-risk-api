// Plain Node HTTP server entry point (no dependencies).
// The request handler is runtime-agnostic; this file is the Node adapter.
import http from 'node:http';
import { handle } from './handler.js';

const port = Number(process.env.PORT || 8787);

const server = http.createServer(async (req, res) => {
  try {
    const _host = req.headers.host || 'localhost';
    const _fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const _proto = _fwdProto || (_host.startsWith('localhost') || _host.startsWith('127.') ? 'http' : 'https');
    const url = new URL(req.url, `${_proto}://${_host}`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);
    const result = await handle(
      { method: req.method, path: url.pathname, query: url.searchParams, headers, resource: url.toString() },
      process.env,
    );
    const resHeaders = { 'content-type': 'application/json; charset=utf-8', ...result.headers };
    res.writeHead(result.status, resHeaders);
    const isHtml = typeof result.body === 'string' && /text\/html/.test(resHeaders['content-type'] || '');
    res.end(isHtml ? result.body : JSON.stringify(result.body, null, 2));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'internal_error', detail: String(err && err.message || err) }));
  }
});

server.listen(port, () => {
  console.log(`token-risk-api listening on http://localhost:${port}`);
  console.log(`PAYMENT_MODE=${process.env.PAYMENT_MODE || 'mock'} PRICE_ATOMIC=${process.env.PRICE_ATOMIC || '5000'} NETWORK=${process.env.X402_NETWORK || 'base'}`);
});
