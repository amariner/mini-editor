import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runtimeDependencies,
  runtimeFile,
  deduplicateBinaries,
} from '../scripts/package-payload.mjs';

const target = { platform: 'darwin', arch: 'arm64' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-payload-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function pkg(relative, manifest) {
    const directory = path.join(root, relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
  }
  return { root, pkg };
}

test('runtime graph follows nested versions and peers, excludes build-only and foreign optional packages', async (t) => {
  const { root, pkg } = await fixture(t);
  await pkg('node_modules/runtime', {
    name: 'runtime',
    dependencies: { shared: '1' },
    peerDependencies: { peer: '*' },
    optionalDependencies: { missing: '*', foreign: '*' },
    devDependencies: { buildOnly: '*' },
  });
  await pkg('node_modules/runtime/node_modules/shared', { name: 'shared', version: '1' });
  await pkg('node_modules/shared', { name: 'shared', version: '2' });
  await pkg('node_modules/peer', { name: 'peer', dependencies: { shared: '2' } });
  await pkg('node_modules/buildOnly', { name: 'buildOnly' });
  await pkg('node_modules/foreign', { name: 'foreign', os: ['win32'], cpu: ['x64'] });
  const found = await runtimeDependencies(root, ['runtime'], target);
  assert.deepEqual(found.map(({ source }) => path.relative(root, source)).sort(), [
    'node_modules/peer',
    'node_modules/runtime',
    'node_modules/runtime/node_modules/shared',
    'node_modules/shared',
  ]);
  await assert.rejects(runtimeDependencies(root, ['absent'], target), /Falta dependencia/);
});

test('payload filtering keeps runtime assets and licenses but omits maps and foreign native modules', () => {
  for (const file of [
    'package.json',
    'LICENSE',
    'README.md',
    'lib/index.js',
    'prebuilds/darwin-arm64/pty.node',
    'prebuilds/darwin-arm64/spawn-helper',
  ]) {
    assert.equal(runtimeFile('node-pty', file, target), true, file);
  }
  for (const file of [
    'lib/index.js.map',
    'lib/index.test.js',
    'src/unix/pty.cc',
    'prebuilds/win32-x64/pty.node',
    'deps/winpty/src/agent.cc',
    'typings/node-pty.d.ts',
    'node_modules/something/index.js',
  ]) {
    assert.equal(runtimeFile('node-pty', file, target), false, file);
  }
  assert.equal(
    runtimeFile('@github/keytar', 'prebuilds/darwin-arm64/node.napi.node', target),
    true,
  );
  assert.equal(runtimeFile('@github/keytar', 'prebuilds/linux-x64/node.napi.node', target), false);
  assert.equal(runtimeFile('@google/gemini-cli', 'bundle/policies/default.toml', target), true);
  assert.equal(runtimeFile('@google/gemini-cli', 'bundle/docs/help.md', target), true);
});

test('deduplication preserves paths across relocation and keeps different SDK binaries', async (t) => {
  const { root } = await fixture(t);
  const contents = {
    '@anthropic-ai/claude-code/bin/claude.exe': 'claude binary',
    '@anthropic-ai/claude-code-darwin-arm64/claude': 'claude binary',
    '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude': 'other! binary',
    '@opencode/cli/bin/opencode.exe': 'opencode binary',
    '@opencode/cli-darwin-arm64/bin/opencode': 'opencode binary',
  };
  const payload = path.join(root, 'original');
  for (const [relative, value] of Object.entries(contents)) {
    const file = path.join(payload, 'node_modules', relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  const result = await deduplicateBinaries(payload, target);
  assert.equal(result.savedBytes, 'claude binary'.length + 'opencode binary'.length);
  assert.equal(result.links.length, 2);
  const moved = path.join(root, 'Applications', 'Agent Desk.app');
  await fs.mkdir(path.dirname(moved));
  await fs.rename(payload, moved);
  for (const [relative, value] of Object.entries(contents)) {
    assert.equal(await fs.readFile(path.join(moved, 'node_modules', relative), 'utf8'), value);
  }
  assert.equal(
    (
      await fs.lstat(
        path.join(moved, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
      )
    ).isFile(),
    true,
  );
  assert.equal(
    (
      await fs.lstat(path.join(moved, 'node_modules/@anthropic-ai/claude-code-darwin-arm64/claude'))
    ).isSymbolicLink(),
    true,
  );
});
