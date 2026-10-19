import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparePtyHelpers } from '../electron/pty';

test('restaura ejecución del auxiliar macOS en prebuilds y compilaciones locales', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'desk-pty-'));
  const helpers = ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64'].map((directory) =>
    path.join(root, directory, 'spawn-helper'),
  );
  try {
    for (const helper of helpers) {
      mkdirSync(path.dirname(helper), { recursive: true });
      writeFileSync(helper, 'fixture');
      chmodSync(helper, 0o640);
    }
    preparePtyHelpers(root, 'darwin', 'arm64');
    for (const helper of helpers) assert.equal(statSync(helper).mode & 0o777, 0o740);
    // A second launch preserves the repaired permissions.
    preparePtyHelpers(root, 'darwin', 'arm64');
    for (const helper of helpers) assert.equal(statSync(helper).mode & 0o777, 0o740);
    assert.equal(existsSync(path.join(root, 'prebuilds/darwin-x64')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('omite auxiliares ausentes y no modifica permisos en otras plataformas', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'desk-pty-'));
  const helper = path.join(root, 'build/Release/spawn-helper');
  try {
    assert.doesNotThrow(() => preparePtyHelpers(root, 'darwin', 'arm64'));
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, 'fixture');
    chmodSync(helper, 0o644);
    preparePtyHelpers(root, 'linux', 'arm64');
    assert.equal(statSync(helper).mode & 0o777, 0o644);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
