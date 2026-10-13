// Real Electron networking, isolated synthetic proxy; no accounts or remote requests.
import { build } from 'esbuild';
import electron from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-provider-proxy-'));
const entry = path.join(root, 'check.cjs');
try {
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import { app, session } from 'electron';
import http from 'node:http';
import assert from 'node:assert/strict';
import { providerFetch } from './electron/provider-fetch';
void (async () => {
app.setPath('userData', ${JSON.stringify(root)});
await app.whenReady();
const expected = 'Basic ' + Buffer.from('fixture:password').toString('base64');
let challenges = 0, credentialLookups = 0, connectionsClosed = 0;
const sockets = new Set();
const proxy = http.createServer((req, res) => {
  if (req.headers['proxy-authorization'] !== expected) {
    challenges++;
    res.writeHead(407, {'Proxy-Authenticate': 'Basic realm="fixture"'});
    return res.end();
  }
  const route = new URL(req.url).pathname;
  if (route === '/origin-auth') {
    res.writeHead(401, {'WWW-Authenticate': 'Basic realm="origin"'});
    return res.end();
  }
  if (route === '/redirect') {
    res.writeHead(302, {Location: 'http://other.example.test/key'});
    return res.end();
  }
  if (route === '/stream') {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: first\\n\\n');
    res.on('close', () => connectionsClosed++);
    return;
  }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({body, method: req.method}));
  });
});
proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;
const ses = session.fromPartition('provider-proxy-test');
await ses.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:' + port});
const credentials = { credentials(host, p) {
  credentialLookups++;
  assert.equal(host, '127.0.0.1'); assert.equal(p, port);
  return {username:'fixture',password:'password'};
}};
const url = 'http://provider.example.test';
const headers = {Authorization:'Bearer fixture-key'};
const freshAuth = async () => { await ses.clearAuthCache(); await ses.closeAllConnections(); };
try {
  // Reproduce the original bug without involving any real credentials.
  assert.equal((await ses.fetch(url + '/key')).status, 407);
  console.log('Original 407 reproduced.');
  const response = await providerFetch(ses, credentials, url + '/key', {
    method:'POST', headers, body:JSON.stringify({model:'fixture'})
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {method:'POST',body:'{"model":"fixture"}'});
  assert.ok(challenges > 0); assert.equal(credentialLookups, 1);
  console.log('Authenticated POST passed.');
  await freshAuth();
  let attempts = 0;
  await assert.rejects(providerFetch(ses, {credentials(){ attempts++; return {username:'fixture',password:'wrong'}; }}, url + '/key'), /407/);
  assert.equal(attempts, 3, 'bad proxy credentials stop retrying');
  console.log('Retry bound passed.');
  await freshAuth();
  await assert.rejects(providerFetch(ses, {credentials(){return undefined;}}, url + '/key'), /407/);
  await freshAuth();
  const origin = await providerFetch(ses, credentials, url + '/origin-auth');
  assert.equal(origin.status, 401); await origin.body.cancel();
  await assert.rejects(providerFetch(ses, credentials, url + '/redirect', {headers}), /redirect/i);
  const control = new AbortController();
  const stream = await providerFetch(ses, credentials, url + '/stream', {signal:control.signal});
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  const pending = reader.read();
  control.abort();
  await assert.rejects(pending, /abort/i);
  const cancelled = await providerFetch(ses, credentials, url + '/stream');
  await cancelled.body.cancel();
  for(let i=0; connectionsClosed < 2 && i<50;i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(connectionsClosed, 2);
  console.log('PASS: reproduced fetch 407; proxy auth, JSON POST, bounded retries, missing credentials, origin isolation, redirect rejection, SSE abort and cancel.');
} finally {
  for (const socket of sockets) socket.destroy();
  proxy.close();
}
app.quit();
})().catch(error => { console.error(error); app.exit(1); });
`,
    },
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [entry], { env, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  clearTimeout(timer);
  if (code !== 0) throw Error('Provider proxy regression failed: ' + code);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
