import { createTestAccounts } from './test-accounts.mjs';
// Isolated Electron UI/lifecycle check. No prompts or existing credentials are used.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-tabs-')));
const folder = path.join(root, 'Proyecto temporal');
await fs.mkdir(folder);
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snap = () => call({ type: 'snapshot' });
const settle = async () => {
  await page.waitForFunction(() => !document.querySelector('.new-tab')?.disabled);
  await page.waitForTimeout(150);
};
try {
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
  await page.waitForFunction(() => !!window.desk);
  await createTestAccounts(page);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await page.getByRole('button', { name: 'Añadir proyecto', exact: true }).first().click();
  await settle();
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Borrador conservado');
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
  await settle();
  await page.getByRole('tab', { name: 'Sesión 1', exact: true }).click();
  await settle();
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Borrador conservado',
  );
  await page.getByRole('combobox', { name: 'Cuenta del chat' }).selectOption('codex');
  await page.waitForFunction(
    () => document.querySelector('.account-switcher select')?.value === 'codex',
  );
  await settle();
  const first = (await snap()).selectedSession;
  await call({ type: 'start', sessionId: (await snap()).selectedSession });
  for (let i = 0; i < 100; i++) {
    if ((await snap()).sessions.find((s) => s.id === first)?.status === 'ready') break;
    await page.waitForTimeout(100);
  }
  assert.equal((await snap()).sessions.find((s) => s.id === first).status, 'ready');
  await call({ type: 'setDefaultAccount', profile: 'codex' });
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
    await settle();
  }
  assert.equal(await page.getByRole('tab').count(), 5);
  assert.equal((await snap()).sessions.filter((s) => s.profile === 'codex').length, 7);
  await page.getByRole('tab', { name: 'Sesión 1', exact: true }).click();
  await settle();
  assert.equal((await snap()).sessions.find((s) => s.id === first).status, 'ready');
  await page.getByRole('button', { name: 'Cerrar Sesión 1', exact: true }).click();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal((await snap()).sessions.find((s) => s.id === first).status, 'ready');
  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-2',
  });
  await settle();
  assert.equal(await page.getByRole('tab').count(), 5);
  await page.getByRole('tab', { name: 'Sesión 1', exact: true }).click();
  await settle();
  assert.equal(await page.getByRole('tab').count(), 5);
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/28-selector-pestanas.png', animations: 'disabled' });
  assert.equal(await page.locator('.brand,.brand-mark').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Ajustes', exact: true }).innerText(), '');
  const collapse = await page.getByRole('button', { name: 'Plegar proyectos' }).boundingBox();
  const settings = await page.getByRole('button', { name: 'Ajustes', exact: true }).boundingBox();
  assert.ok(collapse.x < settings.x && Math.abs(collapse.y - settings.y) < 1);
  assert.ok(collapse.height >= 28 && settings.height >= 28);
  await page.getByRole('button', { name: 'Plegar proyectos' }).click();
  await page.setViewportSize({ width: 900, height: 620 });
  await page.screenshot({ path: 'artifacts/29-pestanas-compactas.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Cerrar Sesión 1', exact: true }).click();
  await page.getByRole('button', { name: 'Detener y cerrar', exact: true }).click();
  await page.getByRole('dialog', { name: 'Cerrar conversación' }).waitFor({ state: 'hidden' });
  await settle();
  assert.equal((await snap()).sessions.find((s) => s.id === first).status, 'stopped');
  assert.equal(await page.getByRole('tab').count(), 4);
  while (await page.getByRole('tab').count()) {
    await page.locator('.tab-close').last().click();
    await settle();
  }
  await page.getByRole('heading', { name: 'Todo listo', exact: true }).waitFor();
  // Project navigation must respect an explicitly empty tab set. Closed chats
  // remain recoverable with their history and draft, without reopening on return.
  const closedProject = (await snap()).selectedProject;
  const historyOf = (state) =>
    state.sessions
      .filter((session) => session.projectId === closedProject)
      .map(({ id, messages, reference }) => ({ id, messages, reference }));
  const closedHistory = historyOf(await snap());
  const secondFolder = path.join(root, 'Otro proyecto');
  await fs.mkdir(secondFolder);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, secondFolder);
  await page.getByRole('button', { name: 'Añadir proyecto', exact: true }).first().click();
  await settle();
  assert.notEqual((await snap()).selectedProject, closedProject);
  await page.getByRole('button', { name: 'Proyecto temporal', exact: true }).click();
  await settle();
  assert.equal((await snap()).selectedProject, closedProject);
  assert.equal(
    await page.getByRole('tab').count(),
    0,
    'Returning to a project must not reopen its explicitly closed tabs',
  );
  await page.getByRole('heading', { name: 'Todo listo', exact: true }).waitFor();
  assert.deepEqual(historyOf(await snap()), closedHistory);
  await page.keyboard.press('Meta+k');
  await page.getByPlaceholder('Buscar proyecto o sesión…').fill('Sesión 1');
  await page
    .locator('.palette-results button')
    .filter({ hasText: 'Codex' })
    .filter({ hasText: 'Proyecto temporal' })
    .click();
  await settle();
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.equal((await snap()).selectedSession, first);
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Borrador conservado',
  );
  // Tab arrows activate the neighboring conversation without leaving focus in stale content.
  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-2',
  });
  await settle();
  await page.locator('.session-tabs [role="tab"][aria-selected="true"]').focus();
  await page.keyboard.press('Home');
  await settle();
  assert.equal((await snap()).selectedSession, first);
  assert.ok(
    await page
      .locator('.session-tabs [role="tab"][aria-selected="true"]')
      .evaluate((element) => element === document.activeElement),
  );
  // A real Claude PTY remains alive while a different chat is selected.
  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-1',
    mode: 'terminal',
  });
  await settle();
  const terminalId = (await snap()).selectedSession;
  const terminalTitle = (await snap()).sessions.find((s) => s.id === terminalId).title;
  await call({ type: 'start', sessionId: terminalId });
  const other = await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-2',
  });
  await settle();
  assert.equal((await snap()).sessions.find((s) => s.id === terminalId).status, 'terminal');
  await page.getByRole('tab', { name: terminalTitle, exact: true }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await settle();
  assert.equal(await page.locator('.xterm').count(), 1);
  await page.getByRole('button', { name: `Cerrar ${terminalTitle}`, exact: true }).click();
  await page.getByRole('button', { name: 'Detener y cerrar', exact: true }).click();
  await page.getByRole('dialog', { name: 'Cerrar conversación' }).waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(
    'OK: selector, 5 tabs, running process protected, drafts, mixed-account tabs, close cancellation/confirmed stop, empty state, CmdK recovery, compact layout.',
  );
} finally {
  if (app) await app.close();
}
