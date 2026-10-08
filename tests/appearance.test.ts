import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTheme, writeTheme } from '../electron/appearance';
import { actionSchema } from '../electron/core';

test('el tema se guarda junto a los datos y un archivo ausente o raro vuelve a Sistema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-theme-'));
  try {
    assert.equal(readTheme(dir), 'system');
    writeTheme(dir, 'dark');
    assert.equal(readTheme(dir), 'dark');
    assert.equal(fs.statSync(path.join(dir, 'appearance.json')).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dir, 'appearance.json'), '{"theme":"sepia"}');
    assert.equal(readTheme(dir), 'system');
    fs.writeFileSync(path.join(dir, 'appearance.json'), 'no es json');
    assert.equal(readTheme(dir), 'system');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('IPC solo acepta los tres temas', () => {
  for (const theme of ['system', 'light', 'dark'])
    assert.equal(actionSchema.safeParse({ type: 'setTheme', theme }).success, true);
  assert.equal(actionSchema.safeParse({ type: 'setTheme', theme: 'sepia' }).success, false);
});
