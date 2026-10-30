import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

const bundle = build({
  entryPoints: [fileURLToPath(new URL('../electron/provider-fetch.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['electron'],
});
async function fixture() {
  let aborts = 0;
  let options: any;
  const request = Object.assign(new EventEmitter(), {
    end() {},
    abort() {
      aborts++;
    },
  });
  const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
  const require = createRequire(import.meta.url);
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', (await bundle).outputFiles[0].text)(
    (name: string) =>
      name === 'electron'
        ? {
            net: {
              request: (value: any) => {
                options = value;
                return request;
              },
            },
          }
        : require(name),
    module,
    module.exports,
  );
  return {
    request,
    response,
    get aborts() {
      return aborts;
    },
    get options() {
      return options;
    },
    fetch: (init?: RequestInit) =>
      module.exports.providerFetch(
        {},
        { credentials: () => undefined },
        'https://provider.example.test',
        init,
      ) as Promise<Response>,
    classify: module.exports.providerNetworkError as (error: Error) => Error,
  };
}

test('una API sin cabeceras ni señal externa expira y libera su conexión', async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = assert.rejects(f.fetch(), /90 segundos/);
  t.mock.timers.tick(90_000);
  await pending;
  assert.equal(f.aborts, 1);
  assert.equal(f.options.useSessionCookies, false);
  assert.equal(f.options.redirect, 'error');
});

test('una respuesta en pausa respeta al consumidor y vuelve a detectar inactividad al leer', async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.fetch();
  f.request.emit('response', f.response);
  const response = await pending;
  f.response.write(Buffer.from('first'));
  assert.equal(f.response.isPaused(), true);
  t.mock.timers.tick(180_000);
  assert.equal(f.aborts, 0, 'consumer backpressure is not network inactivity');
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  const next = assert.rejects(reader.read(), /90 segundos/);
  t.mock.timers.tick(90_000);
  await next;
  assert.equal(f.aborts, 1);
});

test('cancelar o responder HEAD elimina el timeout y cancela la petición nativa', async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const control = new AbortController();
  const pending = f.fetch({ signal: control.signal });
  f.request.emit('response', f.response);
  const response = await pending;
  const read = assert.rejects(response.body!.getReader().read(), /abort/i);
  control.abort();
  await read;
  assert.equal(f.aborts, 1);
  t.mock.timers.tick(180_000);
  assert.equal(f.aborts, 1);
  const head = await fixture();
  const headers = head.fetch({ method: 'head' });
  head.request.emit('response', head.response);
  assert.equal((await headers).body, null);
  assert.equal(head.options.method, 'HEAD');
  assert.equal(head.aborts, 1);
});

test('errores de red orientan al usuario y 407 nunca espera datos indefinidamente', async () => {
  const f = await fixture();
  assert.match(f.classify(new Error('net::ERR_PROXY_CONNECTION_FAILED')).message, /proxy/);
  assert.match(f.classify(new Error('net::ERR_CERT_AUTHORITY_INVALID')).message, /certificado/);
  assert.match(f.classify(new Error('net::ERR_CONNECTION_RESET')).message, /conexión/);
  const pending = assert.rejects(f.fetch(), /407/);
  f.response.statusCode = 407;
  f.request.emit('response', f.response);
  await pending;
  assert.equal(f.aborts, 1);
});
