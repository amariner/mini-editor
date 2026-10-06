// Real official account endpoints in fresh temporary profiles; never use the user's credentials.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-accounts-')));
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snapshot = () => call({ type: 'snapshot' });
async function poll(predicate) {
  const start = Date.now();
  while (true) {
    const state = await snapshot();
    if (predicate(state)) return state;
    if (Date.now() - start > 45000)
      throw new Error('Estado de prueba no alcanzado: ' + JSON.stringify(state.accounts));
    await new Promise((r) => setTimeout(r, 80));
  }
}
const settled = () => poll((s) => Object.values(s.accounts).every((a) => !a.busy));
async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  // Observe official login URLs without navigating the user's browser in this test.
  await app.evaluate(({ shell }) => {
    globalThis.accountTestUrls = [];
    shell.openExternal = async (url) => {
      globalThis.accountTestUrls.push(new URL(url).hostname);
    };
  });
}
try {
  await fs.mkdir('artifacts', { recursive: true });
  await launch();
  assert.equal((await snapshot()).projects.length, 0);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await poll((s) => Object.values(s.accounts).every((a) => a.status !== 'unknown' || a.error));
  await settled();
  for (const profile of ['claude-1', 'claude-2', 'codex'])
    assert.equal(
      (await snapshot()).accounts[profile].status,
      'signedOut',
      JSON.stringify((await snapshot()).accounts[profile]),
    );
  await page.screenshot({ path: 'artifacts/23-ajustes-cuentas.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: 'artifacts/24-ajustes-cuentas-oscuro.png',
    animations: 'disabled',
  });
  const codex = page.getByRole('region', { name: 'Cuenta Codex', exact: true });
  await codex.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await poll((s) => s.accounts.codex.cancellable);
  assert.deepEqual(await app.evaluate(() => globalThis.accountTestUrls), ['auth.openai.com']);
  await assert.rejects(
    call({ type: 'accountLogout', profile: 'codex', stopSessions: true }),
    /operación de cuenta/,
  );
  // Closing and reopening settings preserves the pending official OAuth flow.
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await codex.getByRole('button', { name: 'Cancelar acceso', exact: true }).click();
  await settled();
  assert.equal((await snapshot()).accounts.codex.status, 'signedOut');
  // Actual logout commands on empty profiles: idempotent and harmless, no credentials copied.
  for (const name of ['Claude 1', 'Claude 2', 'Codex']) {
    await page
      .getByRole('region', { name: `Cuenta ${name}`, exact: true })
      .getByRole('button', { name: 'Cerrar sesión', exact: true })
      .click();
    await page
      .getByRole('alertdialog', { name: 'Confirmar cambio de cuenta' })
      .getByRole('button', { name: 'Confirmar cierre de sesión' })
      .click();
    await settled();
  }
  for (const profile of ['claude-1', 'claude-2', 'codex'])
    assert.equal(
      (await snapshot()).accounts[profile].status,
      'signedOut',
      JSON.stringify((await snapshot()).accounts[profile]),
    );
  // Spawn and cancel the real Claude auth process before completing its browser flow.
  await call({ type: 'accountLogin', profile: 'claude-1', stopSessions: false });
  let s = await snapshot();
  assert.equal(s.accounts['claude-1'].terminalId, 'account:claude-1');
  await call({ type: 'accountCancel', profile: 'claude-1' });
  assert.equal((await snapshot()).accounts['claude-1'].busy, undefined);
  assert.equal((await snapshot()).accounts['claude-2'].status, 'signedOut');
  // Check a live project's process must be confirmed stopped before sign-out.
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await call({ type: 'addProject' });
  const p = (await snapshot()).projects[0];
  await call({ type: 'select', projectId: p.id, profile: 'codex' });
  const sessionId = (await snapshot()).selectedSession;
  await call({ type: 'start', sessionId });
  await assert.rejects(
    call({ type: 'accountLogout', profile: 'codex', stopSessions: false }),
    /Confirma la parada/,
  );
  assert.equal((await snapshot()).sessions.find((s) => s.id === sessionId).status, 'ready');
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await settled();
  await codex.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await page.getByRole('alertdialog').getByText('Cancelar', { exact: true }).click();
  assert.equal((await snapshot()).sessions.find((s) => s.id === sessionId).status, 'ready');
  await codex.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar cierre de sesión', exact: true }).click();
  await settled();
  s = await snapshot();
  assert.equal(s.sessions.find((s) => s.id === sessionId).status, 'stopped');
  assert.equal(s.accounts.codex.status, 'signedOut');
  assert.equal(s.projects[0].path, project);
  assert.deepEqual(await fs.readdir(project), []);
  const saved = s.sessions.map(({ id, messages, reference }) => ({ id, messages, reference }));
  await app.close();
  app = undefined;
  await launch();
  s = await snapshot();
  assert.deepEqual(
    s.sessions.map(({ id, messages, reference }) => ({ id, messages, reference })),
    saved,
  );
  assert.equal(s.accounts.codex.status, 'unknown');
  // Quitting also cancels pending account authentication and reaps its process.
  await call({ type: 'accountLogin', profile: 'codex', stopSessions: false });
  const appPid = app.process().pid;
  const children = execFileSync('ps', ['-axo', 'pid,ppid'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((row) => row.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === appPid)
    .map(([pid]) => pid);
  await app.close();
  app = undefined;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const exitDeadline = Date.now() + 5000;
  while (children.some(alive) && Date.now() < exitDeadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    children.filter(alive),
    [],
    'No quedan procesos de autenticación después de salir',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      real: [
        'estado de 3 perfiles',
        'inicio/cancelación OAuth Codex',
        'PTY Claude inicio/cancelación',
        'logout Claude y Codex en perfiles vacíos',
        'parada confirmada antes de logout',
        'historial conservado',
      ],
      pending: 'Completar OAuth con la cuenta del usuario y logout de una cuenta autenticada',
      modelCalls: 0,
    }),
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
