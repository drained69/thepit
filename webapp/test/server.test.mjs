import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSiteServer, staticPath } from '../serve.mjs';

test('static paths cannot escape the build directory', () => {
  const root = '/tmp/pit-dist';
  assert.equal(staticPath(root, '/assets/main.js'), '/tmp/pit-dist/assets/main.js');
  for (const bad of ['/%', '/%00', '/../pit-dist-secret/key', '/..%2Fsecret/key', '/%5csecret']) assert.throws(() => staticPath(root, bad));
});
test('production server survives malformed paths and preserves HTTP semantics', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pit-site-test-'));
  await fs.writeFile(path.join(root, 'index.html'), '<main>The Pit</main>');
  await fs.mkdir(path.join(root, 'assets'));
  await fs.writeFile(path.join(root, 'assets/main.js'), 'console.log(1)');
  const server = createSiteServer({root, rheaProxy:async()=>false});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/%')).status, 400);
    assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
    assert.equal((await fetch(base + '/', {method:'POST'})).status, 405);
    const route = await fetch(base + '/launch');
    assert.equal(route.status, 200);
    assert.equal(await route.text(), '<main>The Pit</main>');
    assert.equal(route.headers.get('x-content-type-options'), 'nosniff');
    const head = await fetch(base + '/', {method:'HEAD'});
    assert.equal(head.status, 200); assert.equal(await head.text(), '');
    const asset = await fetch(base + '/assets/main.js');
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.equal((await fetch(base + '/healthz')).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await fs.rm(root,{recursive:true,force:true}); }
});
