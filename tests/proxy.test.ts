import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  ProxySettings,
  proxyUpdateSchema,
  readCorporateCA,
  type SecretCodec,
} from '../electron/proxy';
import { defaultProxy } from '../src/proxy-types';
import { Accounts } from '../electron/accounts';
const key = randomBytes(32);
const codec: SecretCodec = {
  available: () => true,
  encrypt(value) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), encrypted]);
  },
  decrypt(value) {
    const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
    d.setAuthTag(value.subarray(12, 28));
    return d.update(value.subarray(28)) + d.final('utf8');
  },
};
const settings = {
  ...defaultProxy,
  mode: 'manual' as const,
  host: 'proxy.example.test',
  port: 8080,
  username: 'DOMAIN\\user@example.test',
};
async function fixture(run: (p: ProxySettings, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-proxy-'));
  try {
    await run(new ProxySettings(root, codec), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('encrypted proxy credentials persist without appearing in snapshots, files, or errors; identity changes clear them', () =>
  fixture(async (p, root) => {
    const secret = 'secret:@/ password';
    p.save({ ...settings, password: secret });
    const saved = fs.readFileSync(path.join(root, 'network.json'), 'utf8');
    assert.ok(!saved.includes(secret));
    assert.ok(!JSON.stringify(p.snapshot()).includes(secret));
    assert.equal(p.snapshot().hasPassword, true);
    assert.equal(fs.statSync(path.join(root, 'network.json')).mode & 0o777, 0o600);
    const restored = new ProxySettings(root, codec);
    const env = restored.environment();
    const url = new URL(env.HTTPS_PROXY);
    assert.equal(decodeURIComponent(url.username), settings.username);
    assert.equal(decodeURIComponent(url.password), secret);
    assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
    assert.equal(env.https_proxy, env.HTTPS_PROXY);
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(restored.credentials('other.test', 8080), undefined);
    assert.equal(restored.credentials(settings.host, 8081), undefined);
    assert.equal(restored.credentials(settings.host, 8080)?.password, secret);
    assert.doesNotMatch(
      restored.redact(`Could not connect ${env.HTTPS_PROXY} ${secret}`),
      /secret|password/,
    );
    restored.save(settings);
    assert.equal(restored.snapshot().hasPassword, true);
    restored.save({ ...settings, host: 'another.example.test' });
    assert.equal(restored.snapshot().hasPassword, false);
    restored.save({ ...settings, password: secret });
    restored.save({ ...settings, clearPassword: true });
    assert.equal(restored.snapshot().hasPassword, false);
    restored.save({ ...defaultProxy });
    assert.deepEqual(restored.environment(), {});
    assert.equal(restored.browserConfig().mode, 'system');
  }));

test('validation rejects credential URLs, paths and invalid ports; never saves secrets when encryption is unavailable', () =>
  fixture(async (p, root) => {
    for (const host of [
      'http://proxy',
      'user:pass@proxy',
      'proxy/path',
      'proxy:8080',
      'proxy\nHeader: bad',
    ])
      assert.equal(proxyUpdateSchema.safeParse({ ...settings, host }).success, false);
    for (const port of [0, 65536, 1.5])
      assert.equal(proxyUpdateSchema.safeParse({ ...settings, port }).success, false);
    assert.equal(proxyUpdateSchema.safeParse({ ...settings, host: '[::1]' }).success, true);
    assert.throws(() => p.save({ ...settings, host: '' }), /servidor/);
    const unavailable = new ProxySettings(root, { ...codec, available: () => false });
    assert.throws(() => unavailable.save({ ...settings, password: 'secret' }), /texto plano/);
    assert.equal(fs.existsSync(path.join(root, 'network.json')), false);
    fs.writeFileSync(path.join(root, 'network.json'), 'invalid');
    const broken = new ProxySettings(root, codec);
    assert.match(broken.snapshot().error!, /configuración de red/);
    assert.throws(() => broken.environment(), /configuración de red/);
    assert.equal(fs.readFileSync(path.join(root, 'network.json'), 'utf8'), 'invalid');
  }));

test('proxy diagnostics distinguish auth refusal from a verified TLS tunnel and enforce certificates', () =>
  fixture(async (p, root) => {
    const cert = path.join(root, 'ca.pem');
    const privateKey = path.join(root, 'key.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        privateKey,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=chatgpt.com',
      ],
      { stdio: 'ignore' },
    );
    assert.throws(() => readCorporateCA(privateKey), /clave privada/);
    const secureContext = tls.createSecureContext({
      key: fs.readFileSync(privateKey),
      cert: fs.readFileSync(cert),
    });
    const sockets = new Set<import('node:net').Socket>();
    const proxy = http.createServer();
    proxy.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    proxy.on('connect', (req, socket) => {
      assert.equal(req.url, 'chatgpt.com:443');
      if (
        req.headers['proxy-authorization'] !==
        `Basic ${Buffer.from('user:secret').toString('base64')}`
      ) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
      secure.on('error', () => {});
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const config = {
      ...settings,
      host: '127.0.0.1',
      port: (proxy.address() as import('node:net').AddressInfo).port,
      username: 'user',
      password: 'secret',
    };
    try {
      assert.match((await p.test({ ...config, password: 'wrong' }, 'codex')).message, /407/);
      assert.equal((await p.test(config, 'codex')).ok, false, 'untrusted TLS is rejected');
      assert.equal((await p.test({ ...config, caFile: cert }, 'codex')).ok, true);
      p.save({ ...config, caFile: cert });
      const env = p.environment();
      assert.equal(env.NODE_EXTRA_CA_CERTS, cert);
      assert.equal(env.CODEX_CA_CERTIFICATE, cert);
      assert.equal(env.SSL_CERT_FILE, cert);
      assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  }));

test('account checks receive the configured proxy for both providers without putting it in account state', () =>
  fixture(async (p, root) => {
    p.save({ ...settings, password: 'private-test-password' });
    const binary = path.join(root, 'fake-cli');
    fs.writeFileSync(
      binary,
      `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync('env-ok',String(!!process.env.HTTPS_PROXY && !!process.env.NO_PROXY));\nif(process.argv.includes('auth')) console.log(JSON.stringify({loggedIn:false}));\nelse require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined) console.log(JSON.stringify({id:m.id,result:m.method==='account/read'?{account:null}:{}}));});\n`,
      { mode: 0o700 },
    );
    const accounts = new Accounts(
      root,
      () => ({ claude: binary, codex: binary }),
      () => {},
      () => {},
      async () => {},
      () => p.environment(),
    );
    try {
      for (const id of ['claude-1', 'codex'] as const) {
        accounts.register(id);
        await accounts.refresh(id);
        assert.equal(fs.readFileSync(path.join(root, 'profiles', id, 'env-ok'), 'utf8'), 'true');
        assert.equal(accounts.state[id].status, 'signedOut');
      }
      assert.ok(!JSON.stringify(accounts.state).includes('private-test-password'));
    } finally {
      await accounts.shutdown();
    }
  }));
