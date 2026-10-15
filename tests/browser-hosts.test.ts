import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { localURLs, localEndpoint, hostOnline } from '../electron/browser-hosts';
test('detecta solo URLs de servidores locales explícitos, con ANSI e IPv6', () => {
  assert.deepEqual(
    localURLs(
      '\x1b[32mLocal: http://localhost:4317/\x1b[0m\nhttp://localhost:4317/next\nhttp://0.0.0.0:3000\nhttps://[::1]:8443/',
    ),
    ['http://localhost:4317/', 'http://127.0.0.1:3000/', 'https://[::1]:8443/'],
  );
  assert.deepEqual(
    localURLs(
      'https://example.com:443 https://localhost.example.com:1234 http://192.168.1.1:3000 http://localhost:99999',
    ),
    [],
  );
  assert.equal(localEndpoint('https://example.com'), undefined);
});
test('el estado procede de un puerto real y detecta su cierre', async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  try {
    assert.equal(await hostOnline(url), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await hostOnline(url), false);
  assert.equal(await hostOnline('https://example.com'), undefined);
});

test('dev ports belong to their chat, survive tab closure and disappear when offline', async () => {
  const { DevServerRegistry } = await import('../electron/browser-hosts');
  const first = net.createServer((socket) => socket.end());
  const second = net.createServer((socket) => socket.end());
  await Promise.all(
    [first, second].map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))),
  );
  const a = (first.address() as net.AddressInfo).port;
  const b = (second.address() as net.AddressInfo).port;
  const registry = new DevServerRegistry();
  try {
    await registry.observe(
      'p',
      'chat-a',
      `http://127.0.0.1:${a}/ http://localhost:${a}/next http://127.0.0.1:${b}/`,
    );
    assert.equal(registry.snapshot().length, 2);
    assert.ok(registry.snapshot().every((s) => s.sessionId === 'chat-a'));
    await registry.observe('p', 'chat-b', `http://127.0.0.1:${b}/`);
    assert.equal(registry.snapshot().filter((s) => s.sessionId === 'chat-b').length, 1);
    await new Promise<void>((resolve) => first.close(() => resolve()));
    assert.equal(await registry.refresh(), true);
    assert.ok(registry.snapshot().every((s) => s.port === b));
    registry.removeProject('p');
    assert.deepEqual(registry.snapshot(), []);
  } finally {
    for (const s of [first, second])
      if (s.listening) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

test('a pending dev-port probe cannot restore a removed project', async () => {
  const { DevServerRegistry } = await import('../electron/browser-hosts');
  let finish!: (online: boolean) => void;
  const registry = new DevServerRegistry(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = registry.observe('p', 'chat', 'http://localhost:3000/');
  registry.removeProject('p');
  finish(true);
  await pending;
  assert.deepEqual(registry.snapshot(), []);
});
