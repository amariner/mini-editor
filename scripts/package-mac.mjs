// Local macOS distribution using the installed Electron runtime. No Apple account required.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build as buildRenderer } from 'vite';
import { build } from 'esbuild';
import electron from 'electron';
import { buildOptions } from './build-options.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (process.platform !== 'darwin') throw new Error('Genera el instalador desde macOS.');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
const release = path.join(root, 'release');
const output = path.join(release, `mac-${process.arch}`);
const app = path.join(output, 'Agent Desk.app');
const image = path.join(release, `Agent-Desk-${pkg.version}-mac-${process.arch}.dmg`);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });

// Fail before touching a previous distribution if dependencies or types are incomplete.
const dependencies = run('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})
  .trim()
  .split('\n')
  .filter((p) => p !== root);
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
await fs.mkdir(release, { recursive: true });
// Build privately so packaging never replaces the running development bundles.
const staging = await fs.mkdtemp(path.join(release, '.package-'));
try {
  const stagedApp = path.join(staging, 'Agent Desk.app');
  await fs.cp(path.resolve(electron, '../../..'), stagedApp, {
    recursive: true,
    verbatimSymlinks: true,
  });
  const stagedContents = path.join(stagedApp, 'Contents');
  const stagedResources = path.join(stagedContents, 'Resources');
  const stagedPayload = path.join(stagedResources, 'app');
  await fs.rm(path.join(stagedResources, 'default_app.asar'), { force: true });
  await fs.mkdir(stagedPayload);
  await fs.writeFile(
    path.join(stagedPayload, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        productName: 'Agent Desk',
        version: pkg.version,
        type: 'module',
        main: pkg.main,
      },
      null,
      2,
    ) + '\n',
  );
  await buildRenderer({ build: { outDir: path.join(stagedPayload, 'dist') } });
  await build({
    ...buildOptions,
    outdir: path.join(stagedPayload, 'dist-electron'),
    sourcemap: false,
  });

  console.log('Copiando dependencias de producción…');
  // Ancestors already include their nested node_modules. Never copy repository data.
  const directories = dependencies.sort((a, b) => a.length - b.length);
  const copied = [];
  for (const source of directories) {
    // npm ls can list virtual optional packages for other platforms without a directory.
    try {
      await fs.lstat(source);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (copied.some((p) => source.startsWith(p + path.sep))) continue;
    const relative = path.relative(root, source);
    if (!relative.startsWith('node_modules/')) throw new Error(`Dependencia externa: ${source}`);
    await fs.cp(source, path.join(stagedPayload, relative), {
      recursive: true,
      verbatimSymlinks: true,
    });
    copied.push(source);
  }
  const bin = path.join(stagedPayload, 'node_modules/.bin');
  await fs.mkdir(bin, { recursive: true });
  for (const [name, target] of Object.entries({
    claude: '../@anthropic-ai/claude-code/bin/claude.exe',
    gemini: '../@google/gemini-cli/bundle/gemini.js',
    opencode: '../@opencode/cli/bin/opencode.exe',
  })) {
    // Install scripts select/copy the native binaries. Check their output explicitly.
    await fs.access(path.resolve(bin, target));
    await fs.symlink(target, path.join(bin, name));
    await fs.chmod(path.resolve(bin, target), 0o755);
  }
  // Gemini and child tools can run Node scripts even when Finder has no Node on PATH.
  await fs.writeFile(
    path.join(bin, 'node'),
    '#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${0%/*}/../../../../MacOS/Agent Desk" "$@"\n',
    { mode: 0o755 },
  );
  // Make every shipped node-pty spawn-helper executable before sealing the bundle.
  async function prepare(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await prepare(file);
      else if (entry.name === 'spawn-helper') await fs.chmod(file, 0o755);
    }
  }
  await prepare(path.join(stagedPayload, 'node_modules/node-pty'));
  await fs.rename(
    path.join(stagedContents, 'MacOS/Electron'),
    path.join(stagedContents, 'MacOS/Agent Desk'),
  );
  const plist = path.join(stagedContents, 'Info.plist');
  const set = (key, value) => run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  set('CFBundleDisplayName', 'Agent Desk');
  set('CFBundleName', 'Agent Desk');
  set('CFBundleExecutable', 'Agent Desk');
  set('CFBundleIdentifier', 'local.agentdesk.desktop');
  set('CFBundleShortVersionString', pkg.version);
  set('CFBundleVersion', pkg.version);
  run('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity', plist]);
  // An ad-hoc signature works locally on Apple Silicon; it is not Developer ID/notarization.
  console.log('Firmando localmente y verificando el paquete…');
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', stagedApp]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
  await fs.mkdir(output, { recursive: true });
  await fs.rm(app, { recursive: true, force: true });
  await fs.rename(stagedApp, app);
  run(process.execPath, ['scripts/package-check.mjs', app]);
  const disk = path.join(staging, 'disk');
  await fs.mkdir(disk);
  // ditto preserves the signed bundle and all framework symlinks.
  run('/usr/bin/ditto', [app, path.join(disk, 'Agent Desk.app')]);
  await fs.symlink('/Applications', path.join(disk, 'Applications'));
  await fs.writeFile(
    path.join(disk, 'Instalar.txt'),
    [
      `Agent Desk ${pkg.version} · macOS ${process.arch}`,
      '',
      'Arrastra Agent Desk.app a Applications. Después, ábrela desde Aplicaciones.',
      'Si macOS bloquea la apertura: Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente.',
      'Esta versión tiene firma local, sin Developer ID ni notarización de Apple.',
      '',
      'Datos: ~/Library/Application Support/Agent Desk Installed',
      'La versión de desarrollo conserva sus datos en Agent Desk.',
      'Para actualizar: cierra la app instalada y sustituye Agent Desk.app por la nueva.',
      'Node está incluido. Git y los CLI externos (Codex, Antigravity, Freebuff) se detectan o se eligen en Ajustes.',
      '',
    ].join('\n'),
  );
  run('/usr/bin/hdiutil', [
    'create',
    '-volname',
    'Agent Desk',
    '-srcfolder',
    disk,
    '-ov',
    '-format',
    'UDZO',
    image,
  ]);
  run('/usr/bin/hdiutil', ['verify', image]);
  console.log(`\nInstalador: ${image}\nAplicación: ${app}`);
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
