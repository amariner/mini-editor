import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  chromeEndpoint,
  chromeProfileDirectory,
  installedChrome,
} from '../electron/chrome-browser';

test('Chrome autoConnect accepts only a local browser websocket descriptor', () => {
  assert.equal(
    chromeEndpoint('9222\n/devtools/browser/abc-123\n'),
    'ws://127.0.0.1:9222/devtools/browser/abc-123',
  );
  assert.equal(
    chromeEndpoint(' 12345\r\n/devtools/browser/ABCD_efg\r\n'),
    'ws://127.0.0.1:12345/devtools/browser/ABCD_efg',
  );
  for (const value of [
    '0\n/devtools/browser/id',
    '65536\n/devtools/browser/id',
    '9222abc\n/devtools/browser/id',
    '9222\n//attacker.example/path',
    '9222\n/devtools/page/id',
    '9222\n/devtools/browser/../../x',
    '9222\n/devtools/browser/id?token=1',
    '9222\n/devtools/browser/id\nthird',
  ]) {
    assert.throws(() => chromeEndpoint(value), /conexión inválida/);
  }
});

test('Chrome discovery respects a provided installed executable and does not launch it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-chrome-discovery-'));
  try {
    const executable = path.join(root, 'Google Chrome');
    await fs.writeFile(executable, 'test only');
    await fs.chmod(executable, 0o700);
    assert.equal(await installedChrome(executable), executable);
    await assert.rejects(installedChrome(root), /No se encuentra/);
    assert.equal(
      chromeProfileDirectory('/Users/person', 'darwin'),
      '/Users/person/Library/Application Support/Google/Chrome',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
