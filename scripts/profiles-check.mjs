// Real Electron and official CLIs; empty profiles, no login completed and no model calls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-new-profiles-')));
const folder = path.join(root, 'project');
await fs.mkdir(folder);
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snap = () => call({ type: 'snapshot' });
const until = async (fn) => {
  for (let i = 0; i < 250; i++) {
    const r = await fn();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timeout');
};
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
  await page.emulateMedia({ colorScheme: 'dark' });
}
try {
  await launch();
  let initial = await snap();
  assert.deepEqual(initial.profiles, []);
  assert.deepEqual(initial.accounts, {});
  assert.deepEqual(initial.sessions, []);
  assert.equal(
    await fs.stat(path.join(root, 'data/profiles')).then(
      () => true,
      () => false,
    ),
    false,
  );
  await page.getByRole('button', { name: 'Añadir cuenta', exact: true }).click();
  assert.equal(await page.locator('.account-card').count(), 0);
  await page.getByText('No hay cuentas. Pulsa «Añadir cuenta» para crear la primera.').waitFor();
  await page.getByRole('button', { name: 'Cerrar ajustes' }).click();
  await app.close();
  app = undefined;
  await launch();
  initial = await snap();
  assert.deepEqual(initial.profiles, []);
  assert.deepEqual(initial.accounts, {});
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await call({ type: 'addProject' });
  assert.equal((await snap()).selectedSession, undefined);
  assert.deepEqual((await snap()).sessions, []);
  await page.getByRole('heading', { name: 'Sin cuentas' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Nueva conversación', exact: true }).isDisabled(),
    true,
  );
  await call({ type: 'select', projectId: (await snap()).selectedProject });
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const add = async (kind, name) => {
    await page
      .getByRole('dialog', { name: 'Ajustes', exact: true })
      .getByRole('button', { name: 'Añadir cuenta', exact: true })
      .click();
    await page.getByRole('combobox', { name: 'Proveedor de la nueva cuenta' }).selectOption(kind);
    await page.getByRole('textbox', { name: 'Nombre de la nueva cuenta' }).fill(name);
    await page.getByRole('button', { name: 'Crear perfil', exact: true }).click();
    await page.getByRole('region', { name: `Cuenta ${name}`, exact: true }).waitFor();
  };
  await add('claude', 'Claude trabajo');
  await add('codex', 'Codex personal');
  let state = await snap();
  const claude = state.profiles.find((p) => p.name === 'Claude trabajo');
  const codex = state.profiles.find((p) => p.name === 'Codex personal');
  assert.equal(claude.id, 'claude-1');
  assert.equal(codex.id, 'codex');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].profile, claude.id);
  await until(
    async () =>
      [claude.id, codex.id].every(
        (id) => state.accounts[id]?.status === 'signedOut' && !state.accounts[id]?.busy,
      ) || ((state = await snap()), false),
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/38-cuentas-adicionales.png' });
  await page.getByRole('button', { name: 'Cerrar ajustes' }).click();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await call({ type: 'addProject' });
  const projectId = (await snap()).selectedProject;
  const chooser = page.getByRole('combobox', { name: 'Cuenta del proyecto' });
  await chooser.waitFor();
  assert.equal(await chooser.locator('option').count(), 2);
  for (const profile of [claude.id, codex.id]) {
    await chooser.selectOption(profile);
    const sessionId = (await snap()).selectedSession;
    await call({ type: 'start', sessionId });
    const session = (await snap()).sessions.find((s) => s.id === sessionId);
    assert.equal(session.profile, profile);
    assert.equal(session.status, 'ready', session.error);
    assert.ok(session.info.models.length > 0);
    if (profile === codex.id) assert.ok(session.codexConfig);
  }
  state = await snap();
  const active = state.sessions.filter((s) => s.status === 'ready');
  assert.equal(active.length, 2);
  await assert.rejects(call({ type: 'accountRefresh', profile: 'codex-99' }), /cuenta no existe/);
  // Logging out the new Codex profile stops only that profile and retains Claude.
  await call({ type: 'accountLogout', profile: codex.id, stopSessions: true });
  state = await snap();
  assert.equal(state.sessions.find((s) => s.profile === codex.id).status, 'stopped');
  assert.equal(state.sessions.find((s) => s.profile === claude.id).status, 'ready');
  await call({ type: 'stop', sessionId: state.sessions.find((s) => s.profile === claude.id).id });
  const icons = await page.locator('.composer-chips .chip-btn').allTextContents();
  assert.ok(icons.every((x) => !x.trim()));
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  const tabs = await page.locator('.session-tabs-bar').boundingBox();
  const nav = await page.locator('.browser-toolbar').boundingBox();
  assert.ok(
    Math.abs(tabs.y - nav.y) < 1 && Math.abs(tabs.height - nav.height) < 1,
    JSON.stringify({ tabs, nav }),
  );
  await page.screenshot({ path: 'artifacts/39-iconos-y-alineacion.png' });
  await app.close();
  app = undefined;
  await launch();
  state = await snap();
  assert.equal(state.profiles.length, 2);
  assert.ok(state.sessions.some((s) => s.profile === codex.id && s.status === 'stopped'));
  assert.equal((await fs.stat(path.join(root, 'data/profiles/claude-1'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(root, 'data/profiles/codex'))).isDirectory(), true);
  assert.deepEqual(await fs.readdir(folder), []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: first run and restart without accounts or profile directories, project without accounts, explicit first account, add Claude/Codex via Settings, official empty profile status, two real isolated agent processes, scoped logout, persistence, rejected unregistered profile, icon-only controls, aligned toolbars. Zero model calls.',
  );
} finally {
  await app?.close();
}
