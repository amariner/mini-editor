import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';

test('el streaming continuo guarda el historial aunque no haya pausas entre deltas', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-store-stream-'));
  const store = new Store(root);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = t.mock.method(fs, 'writeFileSync');
  try {
    for (let delta = 0; delta < 20; delta++) {
      store.state.projects = [{ id: 'p', name: `Delta ${delta}`, path: root }];
      store.schedule();
      t.mock.timers.tick(100);
    }
    assert.equal(writes.mock.callCount(), 1);
    assert.equal(new Store(root).state.projects[0].name, 'Delta 19');
    store.state.projects[0].name = 'Final';
    store.schedule();
    t.mock.timers.tick(250);
    assert.equal(writes.mock.callCount(), 2);
    assert.equal(new Store(root).state.projects[0].name, 'Final');
  } finally {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('el guardado explícito cancela el debounce y el plazo máximo pendientes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-store-flush-'));
  const store = new Store(root);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = t.mock.method(store, 'flush');
  try {
    store.schedule();
    store.flush();
    t.mock.timers.tick(5000);
    assert.equal(flush.mock.callCount(), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
