// Isolated Electron lifecycle test. Uses the local Vite server, no authenticated profile.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import electron from 'electron';
import { chromium } from 'playwright';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-runtime-')));
const data = path.join(root, 'data');
const project = path.join(root, 'project');
await fs.mkdir(data);
await fs.mkdir(project);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    projects: [{ id: 'p', name: 'Prueba de actualización', path: project }],
    sessions: [
      { id: 's', projectId: 'p', profile: 'codex', title: 'Sesión de prueba', messages: [] },
    ],
    selectedProject: 'p',
    selectedSession: 's',
    tools: {},
  }),
);
let child, browser, page;
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
async function launch() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  child = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: 'http://127.0.0.1:5173',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Electron no abrió DevTools de prueba')),
      20000,
    );
    child.stderr.on('data', (chunk) => {
      if (chunk.toString().includes('DevTools listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', reject);
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForFunction(() => !!window.desk);
  await page.getByText('Prueba de actualización', { exact: true }).first().waitFor();
}
try {
  await launch();
  let state = await call({ type: 'snapshot' });
  assert.equal(state.runtime.protocol, 8);
  assert.equal(state.runtime.updateAvailable, false);
  await call({ type: 'start', sessionId: 's' });
  state = await call({ type: 'snapshot' });
  assert.ok(state.sessions[0].info.models.length > 1);
  child.send('desk:dev-update');
  const update = page.getByRole('button', { name: 'Actualizar aplicación', exact: true });
  await update.waitFor();
  assert.equal(await update.isDisabled(), true);
  await assert.rejects(call({ type: 'restartApp' }), /Detén las sesiones/);
  assert.equal((await call({ type: 'snapshot' })).sessions[0].status, 'ready');
  await page.screenshot({ path: 'artifacts/22-actualizacion-protegida.png' });
  await call({ type: 'stop', sessionId: 's' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (b) => b.textContent === 'Actualizar aplicación' && !b.disabled,
    ),
  );
  const restart = once(child, 'message');
  const exited = once(child, 'exit');
  await update.click();
  assert.equal((await restart)[0], 'desk:dev-restart');
  await exited;
  await browser.close();
  browser = undefined;
  child = undefined;
  await launch();
  state = await call({ type: 'snapshot' });
  assert.equal(state.runtime.updateAvailable, false);
  assert.equal(state.sessions[0].status, 'stopped');
  assert.equal(state.projects[0].path, project);
  console.log(
    JSON.stringify({
      ok: true,
      verified: [
        'catálogo real',
        'aviso de actualización',
        'reinicio bloqueado con proceso abierto',
        'reinicio permitido tras parada confirmada',
        'organización restaurada',
      ],
      modelCalls: 0,
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.send('desk:dev-quit');
    await exited;
  }
  await browser?.close();
  await fs.rm(root, { recursive: true, force: true });
}
