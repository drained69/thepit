#!/usr/bin/env node
/** Static production server and same-origin funding API. */
import { createRheaProxy } from './server/rhea-proxy.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(import.meta.dirname, 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
};
export function staticPath(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0') || decoded.includes('\\')) throw Error('Invalid path');
  const target = path.resolve(root, '.' + decoded);
  if (target !== root && !target.startsWith(root + path.sep)) throw Error('Invalid path');
  return target;
}
async function existsFile(file) {
  try { return (await fs.promises.stat(file)).isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}
export function createSiteServer({ root = DIST, rheaProxy = createRheaProxy() } = {}) {
  const server = http.createServer(async (req, res) => {
    const fail = (code, message) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(code, {...SECURITY, 'content-type':'text/plain', 'cache-control':'no-store'});
      res.end(req.method === 'HEAD' ? undefined : message);
    };
    try {
      if (await rheaProxy(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://site');
      if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('allow','GET, HEAD'); fail(405, 'Method not allowed'); return; }
      if (url.pathname === '/healthz') { res.writeHead(200, {...SECURITY, 'content-type':'text/plain', 'cache-control':'no-store'}); res.end(req.method === 'HEAD' ? undefined : 'ok'); return; }
      let file;
      try { file = staticPath(root, url.pathname); } catch { fail(400, 'Invalid request path'); return; }
      if (!await existsFile(file)) {
        if (!path.extname(file)) file = await existsFile(file + '.html') ? file + '.html' : path.join(root, 'index.html');
        else { fail(404, 'Not found'); return; }
      }
      if (!await existsFile(file)) { fail(404, 'Not found'); return; }
      const immutable = file.startsWith(path.join(root, 'assets') + path.sep);
      res.writeHead(200, {...SECURITY, 'content-type':TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control':immutable ? 'public, max-age=31536000, immutable' : 'no-cache'});
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(file);
      stream.on('error', () => fail(500, 'Could not read asset'));
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { fail(500, 'Request could not be processed'); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 64;
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  createSiteServer().listen(port, () => console.log(`The Pit site on :${port}`));
}
