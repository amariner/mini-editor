// Real Chromium HTTPS downloads through an isolated authenticated proxy; no remote requests.
import { build } from 'esbuild';
import electron from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-download-proxy-'));
const entry = path.join(root, 'check.cjs');
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(root, 'key.pem'),
      '-out',
      path.join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=download.example.test',
    ],
    { stdio: 'ignore' },
  );
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: String.raw`
import { app, session } from 'electron';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import assert from 'node:assert/strict';
import { downloadFetch } from './electron/download-fetch';
void (async () => {
const root = ${JSON.stringify(root)};
app.setPath('userData', root);
await app.whenReady();
const expected = 'Basic ' + Buffer.from('fixture:password').toString('base64');
const key = fs.readFileSync(root + '/key.pem');
const cert = fs.readFileSync(root + '/cert.pem');
const fingerprint = new X509Certificate(cert).fingerprint256;
let challenges = 0, credentialLookups = 0, cancelledStreams = 0, redirectRequests = 0;
const requests = [];
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
const origin = https.createServer({key, cert}, (req, res) => {
  requests.push(req.url);
  assert.equal(req.headers['proxy-authorization'], undefined);
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers.cookie, undefined);
  if (req.url === '/redirect') {
    redirectRequests++;
    res.writeHead(302, {Location: 'https://cdn.example.test/file'});
    return res.end();
  }
  if (req.url === '/downgrade' || req.url === '/credentials') {
    res.writeHead(302, {Location: req.url === '/downgrade' ? 'http://cdn.example.test/file' : 'https://secret:password@cdn.example.test/file'});
    return res.end();
  }
  if (req.url === '/loop') {
    redirectRequests++;
    res.writeHead(302, {Location: 'https://cdn.example.test/loop'});
    return res.end();
  }
  if (req.url === '/origin-auth') {
    res.writeHead(401, {'WWW-Authenticate': 'Basic realm="origin"'});
    return res.end();
  }
  if (req.url === '/stream') {
    res.writeHead(200, {'content-type':'application/octet-stream'});
    res.write('first chunk');
    res.on('close', () => cancelledStreams++);
    return;
  }
  const payload = Buffer.alloc(512 * 1024, 42);
  res.writeHead(200, {'content-type':'application/octet-stream', 'content-length':payload.length});
  res.end(payload);
});
origin.on('connection', track);
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
const originPort = origin.address().port;
const proxy = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
proxy.on('connection', track);
proxy.on('connect', (req, socket, head) => {
  if (req.headers['proxy-authorization'] !== expected) {
    challenges++;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    return;
  }
  assert.match(req.url, /^(download|cdn)\.example\.test:443$/);
  const upstream = net.connect(originPort, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  track(upstream);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;
const ses = session.fromPartition('download-proxy-test');
await ses.setProxy({mode:'fixed_servers',proxyRules:'http://127.0.0.1:' + proxyPort});
ses.setCertificateVerifyProc((request, callback) => callback(
  ['download.example.test','cdn.example.test'].includes(request.hostname) &&
  new X509Certificate(request.certificate.data).fingerprint256 === fingerprint ? 0 : -2
));
await ses.cookies.set({url:'https://download.example.test', name:'session',value:'private-cookie'});
const credentials = { credentials(host, port) {
  credentialLookups++;
  assert.equal(host,'127.0.0.1'); assert.equal(port,proxyPort);
  return {username:'fixture',password:'password'};
}};
const url = 'https://download.example.test';
const freshAuth = async () => { await ses.clearAuthCache(); await ses.closeAllConnections(); };
try {
  let originalFailed = false;
  try { originalFailed = !(await ses.fetch(url + '/file', {credentials:'omit'})).ok; }
  catch { originalFailed = true; }
  assert.ok(originalFailed, 'original session.fetch omits proxy authentication');
  assert.ok(challenges > 0);
  const response = await downloadFetch(ses, credentials, url + '/redirect', {
    headers:{Authorization:'Bearer private-token',Cookie:'private-cookie','Proxy-Authorization':'private-proxy-token'},
  });
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-length'),String(512 * 1024));
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    assert.ok(chunk.value.every(value => value === 42));
    bytes += chunk.value.length;
    await new Promise(resolve => setTimeout(resolve,2));
  }
  assert.equal(bytes,512 * 1024);
  assert.ok(credentialLookups >= 1);
  assert.equal(redirectRequests,1);
  console.log('Authenticated HTTPS download, CDN redirect, headers, byte integrity and slow consumer passed.');
  await assert.rejects(downloadFetch(ses,credentials,url + '/downgrade'),/HTTPS/);
  await assert.rejects(downloadFetch(ses,credentials,url + '/credentials'),/HTTPS/);
  redirectRequests = 0;
  await assert.rejects(downloadFetch(ses,credentials,url + '/loop'),/redirecciones/);
  assert.equal(redirectRequests,11);
  assert.equal(requests.filter(route => route === '/file').length,1);
  const originAuth = await downloadFetch(ses,credentials,url + '/origin-auth');
  assert.equal(originAuth.status,401);
  await originAuth.body.cancel();
  console.log('Unsafe redirects, redirect loop and origin authentication isolation passed.');
  await freshAuth();
  let attempts = 0;
  await assert.rejects(downloadFetch(ses,{credentials(){attempts++;return {username:'fixture',password:'wrong'};}},url + '/file'),/407/);
  assert.equal(attempts,3);
  await freshAuth();
  await assert.rejects(downloadFetch(ses,{credentials(){return undefined;}},url + '/file'),/407/);
  await freshAuth();
  const control = new AbortController();
  const stream = await downloadFetch(ses,credentials,url + '/stream',{signal:control.signal});
  const streamReader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await streamReader.read()).value),/first chunk/);
  const pending = streamReader.read();
  control.abort();
  await assert.rejects(pending,/abort/i);
  const cancelled = await downloadFetch(ses,credentials,url + '/stream');
  await cancelled.body.cancel();
  for (let i=0; cancelledStreams<2 && i<100;i++) await new Promise(resolve => setTimeout(resolve,10));
  assert.equal(cancelledStreams,2);
  const preAbort = new AbortController(); preAbort.abort();
  await assert.rejects(downloadFetch(ses,credentials,url + '/file',{signal:preAbort.signal}),/abort/i);
  console.log('PASS: download proxy auth, HTTPS redirects, credential isolation, byte integrity, bounded retries, missing credentials, stream abort and cancel.');
} finally {
  await ses.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  proxy.close(); origin.close();
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
  if (code !== 0) throw new Error('Download proxy regression failed: ' + code);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
