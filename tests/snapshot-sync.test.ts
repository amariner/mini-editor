import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotSync } from '../src/snapshot-sync';

function setup() {
  const reads: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  const applied: string[] = [];
  const sync = new SnapshotSync(
    () => {
      return new Promise<string>((resolve, reject) => reads.push({ resolve, reject }));
    },
    (snapshot) => applied.push(snapshot),
  );
  return { reads, applied, sync };
}

test('un snapshot tardío nunca sustituye un evento más reciente', async () => {
  const { sync, reads, applied } = setup();
  const pending = sync.refresh();
  sync.receive('nuevo');
  reads[0].resolve('antiguo');
  await pending;
  assert.deepEqual(applied, ['nuevo']);
  const next = sync.refresh();
  reads[1].resolve('confirmado');
  await next;
  assert.deepEqual(applied, ['nuevo', 'confirmado']);
});

test('lecturas concurrentes conservan únicamente la última solicitada', async () => {
  const { sync, reads, applied } = setup();
  const first = sync.refresh();
  const second = sync.refresh();
  reads[1].resolve('segunda');
  await second;
  reads[0].resolve('primera');
  await first;
  assert.deepEqual(applied, ['segunda']);
});

test('la navegación espera la lectura vigente si su lectura queda superada', async () => {
  const { sync, reads, applied } = setup();
  let finished = false;
  const first = sync.refresh().then(() => {
    finished = true;
  });
  const second = sync.refresh();
  reads[0].resolve('primera');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  reads[1].resolve('segunda');
  await Promise.all([first, second]);
  assert.deepEqual(applied, ['segunda']);
  assert.equal(finished, true);
});

test('invalidar durante el desmontaje descarta respuestas y se puede volver a cargar', async () => {
  const { sync, reads, applied } = setup();
  const pending = sync.refresh();
  sync.invalidate();
  reads[0].resolve('desmontado');
  await pending;
  assert.deepEqual(applied, []);
  const failed = sync.refresh();
  reads[1].reject(new Error('IPC desconectado'));
  await assert.rejects(failed, /IPC desconectado/);
  const retry = sync.refresh();
  reads[2].resolve('recuperado');
  await retry;
  assert.deepEqual(applied, ['recuperado']);
});
