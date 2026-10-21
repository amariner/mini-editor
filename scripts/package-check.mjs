// Exercise the actual distribution outside the repository, without accounts/model requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import electron from 'electron';
import { _electron } from 'playwright';

const appPath = path.resolve(process.argv[2] ?? `release/mac-${process.arch}/Agent Desk.app`);
const executable = path.join(appPath, 'Contents/MacOS/Agent Desk');
const payload = path.join(appPath, 'Contents/Resources/app');
const bin = path.join(payload, 'node_modules/.bin');
const temporary = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-package-')),
);
let installed, development;
const isolatedEnv = {
  ...process.env,
  AGENT_DESK_DEV_URL: '',
  AGENT_DESK_PROFILES_DIR: '',
  // An intentionally minimal PATH verifies the included Node runtime and bundled tools.
  PATH: '/usr/bin:/bin',
  HOME: temporary,
  XDG_CONFIG_HOME: path.join(temporary, 'config'),
  XDG_DATA_HOME: path.join(temporary, 'data'),
  XDG_CACHE_HOME: path.join(temporary, 'cache'),
};
delete isolatedEnv.ELECTRON_RUN_AS_NODE;
try {
  // AppKit/LaunchServices need the real macOS home. Provider checks below use a fake HOME.
  const env = {
    ...isolatedEnv,
    HOME: process.env.HOME,
    AGENT_DESK_DATA_DIR: path.join(temporary, 'installed'),
  };
  installed = await _electron.launch({
    executablePath: executable,
    cwd: temporary,
    env,
    timeout: 30000,
  });
  const page = await installed.firstWindow();
  await page.waitForFunction(() => !!window.desk);
  const snapshot = await page.evaluate(() => window.desk.invoke({ type: 'snapshot' }));
  assert.equal(snapshot.projects.length, 0);
  assert.equal(snapshot.runtime.restartSupported, false);
  assert.ok(page.url().startsWith('file:'));
  for (const name of ['claude', 'gemini']) assert.equal(snapshot.tools[name], path.join(bin, name));
  const details = await installed.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    data: app.getPath('userData'),
    version: app.getVersion(),
  }));
  assert.equal(details.packaged, true);
  assert.equal(details.data, env.AGENT_DESK_DATA_DIR);

  // Open the same compiled code with the development Electron runtime simultaneously.
  development = await _electron.launch({
    executablePath: electron,
    args: [payload],
    cwd: temporary,
    env: {
      ...isolatedEnv,
      HOME: process.env.HOME,
      AGENT_DESK_DATA_DIR: path.join(temporary, 'development'),
    },
    timeout: 30000,
  });
  const devPage = await development.firstWindow();
  await devPage.waitForFunction(() => !!window.desk);
  assert.equal(await development.evaluate(({ app }) => app.isPackaged), false);
  assert.notEqual(details.data, await development.evaluate(({ app }) => app.getPath('userData')));
  await page.evaluate(() => window.desk.invoke({ type: 'snapshot' }));

  // A second installed instance must exit, while development keeps its independent lock.
  const second = spawn(executable, [], { cwd: temporary, env, stdio: 'ignore' });
  const timeout = setTimeout(() => second.kill(), 15000);
  try {
    assert.equal((await once(second, 'exit'))[0], 0);
  } finally {
    clearTimeout(timeout);
  }

  const terminalOutput = await installed.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const requireApp = createRequire(app.getAppPath() + '/package.json');
    const pty = requireApp('node-pty').spawn('/bin/sh', ['-c', 'printf package-pty-ok'], {
      cwd: app.getPath('temp'),
      env: { PATH: '/usr/bin:/bin' },
    });
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        pty.kill();
        reject(new Error('Terminal sin respuesta'));
      }, 10000);
      pty.onData((chunk) => {
        output += chunk;
      });
      pty.onExit(() => {
        clearTimeout(timer);
        resolve(output);
      });
    });
  });
  assert.match(terminalOutput, /package-pty-ok/);
  const nodeVersion = execFileSync(path.join(bin, 'node'), ['-p', 'process.versions.node'], {
    cwd: temporary,
    env: isolatedEnv,
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
  assert.match(nodeVersion, /^\d+\./);
  execFileSync(
    path.join(bin, 'node'),
    [
      '--input-type=module',
      '-e',
      'await import(process.argv[1]); console.log("SDK OK")',
      new URL('file://' + path.join(payload, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'))
        .href,
    ],
    { cwd: temporary, env: isolatedEnv, timeout: 15000, stdio: 'pipe' },
  );
  for (const name of ['claude', 'opencode', 'gemini']) {
    const version = execFileSync(path.join(bin, name), ['--version'], {
      cwd: temporary,
      env: { ...isolatedEnv, PATH: `${bin}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
    assert.ok(version, `${name} no devolvió su versión`);
    console.log(`${name}: ${version}`);
  }
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/package-mac.png' });
  console.log(
    `Paquete ${details.version} OK: renderer, SDK, terminal, Node ${nodeVersion}, CLI y convivencia con desarrollo.`,
  );
} finally {
  await development?.close();
  await installed?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
