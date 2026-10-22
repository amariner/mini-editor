import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';

async function fixture() {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../electron/rpc.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal: string) {
      signals.push(signal);
      return true;
    },
  });
  const require = createRequire(import.meta.url);
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    (name: string) => (name === 'node:child_process' ? { spawn: () => child } : require(name)),
    module,
    module.exports,
  );
  return { rpc: new module.exports.Rpc('fixture', [], '/tmp', {}), child, signals };
}

test('cierres simultáneos comparten proceso y rechazan nuevas llamadas mientras termina', async (t) => {
  const { rpc, child, signals } = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = rpc.stop();
  assert.equal(rpc.stop(), first);
  assert.deepEqual(signals, ['SIGTERM']);
  await assert.rejects(rpc.call('new-work'), /cerrando/);
  child.emit('close', 0);
  await first;
  assert.equal(rpc.listenerCount('closed'), 0);
  t.mock.timers.tick(10000);
  assert.deepEqual(signals, ['SIGTERM']);
  await rpc.stop();
});

test('un cierre sin confirmar libera sus listeners y permite un reintento independiente', async (t) => {
  const { rpc, child, signals } = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(rpc.stop(), /No se ha confirmado/);
  t.mock.timers.tick(7000);
  await rejected;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(rpc.listenerCount('closed'), 0);
  assert.equal(rpc.closed, false);
  const retry = rpc.stop();
  assert.equal(rpc.listenerCount('closed'), 1);
  child.emit('close', 0);
  await retry;
  assert.equal(rpc.listenerCount('closed'), 0);
  t.mock.timers.tick(10000);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL', 'SIGTERM']);
});
