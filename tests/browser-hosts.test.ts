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
