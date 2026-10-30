import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UserApplications, validateApplicationBundle } from '../electron/applications';

const metadata = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
async function fakeBundle(directory: string, name = 'Example.app', extra = {}) {
  const bundle = path.join(directory, name);
  await fs.mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(
    path.join(bundle, 'Contents', 'Info.plist'),
    JSON.stringify({
      CFBundleExecutable: 'example',
      CFBundleDisplayName: name.slice(0, -4),
      CFBundleIdentifier: 'test.example',
      CFBundleShortVersionString: '1.2.3',
      ...extra,
    }),
  );
  await fs.writeFile(path.join(bundle, 'Contents', 'MacOS', 'example'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  return bundle;
}
const copyBundle = (source: string, destination: string) =>
  fs.cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
const fixture = async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-applications-')));
  const home = path.join(root, 'home');
  const system = path.join(root, 'system');
  await fs.mkdir(home);
  await fs.mkdir(system);
  const options = {
    home,
    roots: [path.join(home, 'Applications'), system],
    platform: 'darwin' as const,
    changed() {},
    pathEnvironment: '',
    readMetadata: metadata,
    copyBundle,
  };
  return { root, home, system, options };
};

test('application discovery distinguishes user apps, installed Chrome capabilities and CLI tools without running them', async () => {
  const { root, home, system, options } = await fixture();
  try {
    await fakeBundle(path.join(home, 'Applications'), 'Personal.app');
    await fakeBundle(system, 'Chrome.app', { CFBundleIdentifier: 'com.google.Chrome' });
    await fs.mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.local', 'bin', 'codex'),
      '#!/bin/sh\necho should-never-run\n',
      { mode: 0o755 },
    );
    const manager = new UserApplications(options);
    const first = await manager.refresh();
    assert.equal(first.items.find((item) => item.name === 'Personal')?.scope, 'user');
    assert.equal(first.items.find((item) => item.name === 'Chrome')?.scope, 'system');
    assert.ok(
      first.items
        .find((item) => item.name === 'Chrome')
        ?.capabilities.includes('Control de navegador disponible'),
    );
    assert.equal(first.items.find((item) => item.name === 'codex')?.kind, 'cli');
    assert.equal(first.items.find((item) => item.name === 'codex')?.version, undefined);
    const originalCount = first.items.length;
    first.items.length = 0;
    assert.equal(manager.snapshot().items.length, originalCount);
    await assert.rejects(manager.open('unknown'), /inventario/);
    await assert.rejects(
      manager.open(manager.snapshot().items.find((item) => item.name === 'codex')!.id),
      /terminal/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('user application install preserves internal framework links, publishes a complete bundle and never overwrites an installed app', async () => {
  const { root, home, options } = await fixture();
  try {
    const source = await fakeBundle(root);
    await fs.mkdir(path.join(source, 'Contents', 'Resources'));
    await fs.writeFile(path.join(source, 'Contents', 'Resources', 'asset'), 'retained');
    await fs.symlink('asset', path.join(source, 'Contents', 'Resources', 'current'));
    const manager = new UserApplications(options);
    const result = await manager.install(source);
    assert.equal(result.path, path.join(home, 'Applications', 'Example.app'));
    assert.equal(
      await fs.readFile(path.join(result.path, 'Contents', 'Resources', 'current'), 'utf8'),
      'retained',
    );
    assert.equal(
      await fs.readlink(path.join(result.path, 'Contents', 'Resources', 'current')),
      'asset',
    );
    assert.equal(manager.snapshot().lastInstalled, result.path);
    assert.ok(manager.snapshot().items.some((item) => item.path === result.path));
    await assert.rejects(manager.install(source), /Ya existe/);
    assert.equal(
      await fs.readFile(path.join(result.path, 'Contents', 'Resources', 'asset'), 'utf8'),
      'retained',
    );
    assert.deepEqual(await fs.readdir(path.join(home, 'Applications')), ['Example.app']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('app installs reject escaping links and executable traversal before copying', async () => {
  const { root, options } = await fixture();
  try {
    const source = await fakeBundle(root);
    await fs.writeFile(path.join(root, 'outside'), 'private');
    await fs.symlink('../../../outside', path.join(source, 'Contents', 'outside'));
    const manager = new UserApplications(options);
    await assert.rejects(manager.install(source));
    await fs.unlink(path.join(source, 'Contents', 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(source, 'Contents', 'outside'));
    await assert.rejects(manager.install(source), /enlaces fuera/);
    const traversal = await fakeBundle(root, 'Traversal.app', {
      CFBundleExecutable: '../../../outside',
    });
    await assert.rejects(validateApplicationBundle(traversal, metadata), /ejecutable válido/);
    await assert.rejects(manager.install(path.join(root, 'Installer.pkg')), /\.app/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed application copy cleans only its reservation and staging directory', async () => {
  const { root, home, options } = await fixture();
  try {
    const source = await fakeBundle(root);
    const manager = new UserApplications({
      ...options,
      copyBundle: async (_source, destination) => {
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, 'partial'), 'partial');
        throw new Error('Disk full');
      },
    });
    await assert.rejects(manager.install(source), /Disk full/);
    assert.deepEqual(await fs.readdir(path.join(home, 'Applications')), []);
    assert.equal(manager.snapshot().busy, undefined);
    assert.equal(manager.snapshot().error, 'Disk full');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('installation refuses redirected Applications directories and preserves a changed destination', async () => {
  const { root, home, system, options } = await fixture();
  try {
    const source = await fakeBundle(root);
    await fs.symlink(system, path.join(home, 'Applications'));
    await assert.rejects(new UserApplications(options).install(source), /carpeta de usuario/);
    await fs.unlink(path.join(home, 'Applications'));
    const manager = new UserApplications({
      ...options,
      copyBundle: async (source, destination) => {
        await copyBundle(source, destination);
        await fs.writeFile(path.join(home, 'Applications', 'Example.app', 'user-file'), 'keep');
      },
    });
    await assert.rejects(manager.install(source), /destino cambió/);
    assert.equal(
      await fs.readFile(path.join(home, 'Applications', 'Example.app', 'user-file'), 'utf8'),
      'keep',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an active installation rejects a concurrent install and refresh does not reset its state', async () => {
  const { root, options } = await fixture();
  let release!: () => void;
  let copying!: () => void;
  const started = new Promise<void>((resolve) => {
    copying = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const source = await fakeBundle(root);
    const manager = new UserApplications({
      ...options,
      copyBundle: async (from, to) => {
        copying();
        await barrier;
        await copyBundle(from, to);
      },
    });
    const installed = manager.install(source);
    await started;
    await assert.rejects(manager.install(source), /Ya se está instalando/);
    assert.equal((await manager.refresh()).busy, 'installing');
    release();
    assert.equal((await installed).ok, true);
    assert.equal(manager.snapshot().busy, undefined);
  } finally {
    release?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  'native macOS metadata and copy preserve quarantine without launching the installed app',
  { skip: process.platform !== 'darwin' },
  async () => {
    const { root, options } = await fixture();
    const execute = promisify(execFile);
    try {
      const source = await fakeBundle(root, 'Native.app');
      await fs.writeFile(
        path.join(source, 'Contents', 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>example</string><key>CFBundleName</key><string>Native</string><key>CFBundleIdentifier</key><string>test.native</string></dict></plist>',
      );
      const quarantine = '0081;5e000000;Agent Desk Test;';
      await execute('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, source]);
      const manager = new UserApplications({
        ...options,
        readMetadata: undefined,
        copyBundle: undefined,
      });
      const installed = await manager.install(source);
      assert.equal(installed.name, 'Native');
      // macOS may normalize the quarantine origin/timestamp while copying; the
      // quarantine flags must survive and the source must remain quarantined.
      for (const file of [source, installed.path])
        assert.equal(
          (await execute('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file])).stdout
            .trim()
            .split(';')[0],
          '0081',
        );
      assert.equal(
        (await fs.stat(path.join(installed.path, 'Contents', 'MacOS', 'example'))).mode & 0o777,
        0o755,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
