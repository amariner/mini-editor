import { createTestAccounts } from './test-accounts.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-navigation-')));
const folders = ['Proyecto uno', 'Proyecto dos'].map((x) => path.join(root, x));
for (const folder of folders) await fs.mkdir(folder);
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snap = () => call({ type: 'snapshot' });
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timeout');
};
async function launch() {
  app = await electron.launch({
    timeout: 25000,
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: process.env.SOURCE_DEV_URL ?? '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow({ timeout: 25000 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  await createTestAccounts(page);
  await page.emulateMedia({ colorScheme: 'dark' });
}
try {
  await launch();
  for (const folder of folders) {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, folder);
    await call({ type: 'addProject' });
  }
  await page.getByRole('button', { name: 'Proyecto uno', exact: true }).waitFor();
  await page.locator('.sidebar').hover();
  const plus = await page
    .getByRole('button', { name: 'Añadir proyecto', exact: true })
    .boundingBox();
  const mark = await page.locator('.project-name .project-mark').first().boundingBox();
  assert.ok(Math.abs(plus.x + plus.width / 2 - mark.x - mark.width / 2) < 2);
  const search = page.getByRole('button', { name: 'Buscar proyectos y sesiones' });
  assert.equal(await search.count(), 1, 'Search is always discoverable without a shortcut');
  await page.keyboard.press('Meta+k');
  await page.getByPlaceholder('Buscar proyecto o sesión…').waitFor();
  await page.keyboard.press('Escape');
  // F2 and double-click rename; only free sidebar space folds the whole panel.
  await page.getByRole('button', { name: 'Proyecto uno', exact: true }).focus();
  await page.keyboard.press('F2');
  let input = page.getByRole('textbox', { name: 'Nombre del proyecto', exact: true });
  await input.fill('Landing');
  await input.press('Enter');
  await until(async () => (await snap()).projects.some((p) => p.name === 'Landing'));
  const original = (await snap()).projects.find((p) => p.name === 'Landing');
  assert.equal(original.path, folders[0]);
  assert.equal((await fs.stat(folders[0])).isDirectory(), true);
  await page.getByRole('button', { name: 'Landing', exact: true }).focus();
  await page.keyboard.press('F2');
  await input.fill('Cancelar');
  await input.press('Escape');
  assert.equal((await snap()).projects.find((p) => p.id === original.id).name, 'Landing');
  await page.getByRole('button', { name: 'Landing', exact: true }).focus();
  await page.keyboard.press('F2');
  await input.fill('   ');
  await input.press('Enter');
  assert.equal((await snap()).projects.find((p) => p.id === original.id).name, 'Landing');
  await page.getByRole('button', { name: 'Landing', exact: true }).dblclick();
  await input.waitFor();
  await input.press('Escape');
  await page.locator('.sidebar').dblclick({ position: { x: 2, y: 300 } });
  await page.locator('.sidebar.collapsed').waitFor();
  assert.equal(await search.count(), 1);
  await page.getByRole('button', { name: 'Landing', exact: true }).focus();
  await page.keyboard.press('F2');
  await input.fill('Landing web');
  await page.locator('.sidebar .section-label').click({ position: { x: 1, y: 1 } });
  await until(
    async () => (await snap()).projects.find((p) => p.id === original.id).name === 'Landing web',
  );
  const project = page.getByRole('button', { name: 'Landing web', exact: true });
  if ((await project.getAttribute('aria-expanded')) !== 'true') await project.click();
  const first = (await snap()).selectedSession;
  await project.hover();
  await page.getByRole('button', { name: 'Nuevo chat en Landing web', exact: true }).click();
  const firstChat = page.locator('.project-chat').filter({ hasText: 'Sesión 1' }).first();
  await firstChat.click();
  await firstChat.press('F2');
  const title = page.getByRole('textbox', { name: 'Nombre del chat', exact: true });
  await title.fill('Revisar estilos');
  await title.press('Enter');
  await until(
    async () => (await snap()).sessions.find((s) => s.id === first).title === 'Revisar estilos',
  );
  await page.locator('.project-chat').filter({ hasText: 'Revisar estilos' }).press('F2');
  await title.fill('Cancelar chat');
  await title.press('Escape');
  assert.equal((await snap()).sessions.find((s) => s.id === first).title, 'Revisar estilos');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.xterm').waitFor();
  const workspace = await page.locator('.workspace').boundingBox();
  const terminal = await page.locator('.bottom-terminal').boundingBox();
  assert.ok(
    terminal.y >= workspace.y + workspace.height && Math.abs(terminal.width - workspace.width) < 1,
  );
  const terminalId = `shell:${original.id}`;
  await call({
    type: 'terminalWrite',
    sessionId: terminalId,
    data: "printf '\\nBOTTOM_PTY_OK\\n'; pwd\r",
  });
  await until(async () =>
    (await call({ type: 'terminalBuffer', sessionId: terminalId })).data.includes(folders[0]),
  );
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  assert.equal((await snap()).terminals.length, 1);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.xterm').waitFor();
  assert.ok(
    (await call({ type: 'terminalBuffer', sessionId: terminalId })).data.includes('BOTTOM_PTY_OK'),
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/40-terminal-inferior-nombres.png' });
  const shellInput = page.locator('.terminal-pane .xterm-helper-textarea');
  await shellInput.focus();
  await page.keyboard.type("printf 'SIDEPANEL_DRAFT_OK\\n'");
  await page.locator('.terminal-pane .xterm').evaluate((el) => (el.dataset.dockMarker = 'same'));
  await page.getByRole('button', { name: 'Mover terminal a la derecha', exact: true }).click();
  await page.locator('.right-terminal .xterm').waitFor();
  assert.equal(
    await page.locator('.terminal-pane .xterm').getAttribute('data-dock-marker'),
    'same',
  );
  await shellInput.focus();
  await shellInput.press('Enter');
  await until(async () =>
    (await call({ type: 'terminalBuffer', sessionId: terminalId })).data.includes(
      '\r\nSIDEPANEL_DRAFT_OK\r\n',
    ),
  );
  assert.equal((await snap()).terminals.length, 1);
  assert.ok(await page.locator('.project-chat').filter({ hasText: 'Revisar estilos' }).isVisible());
  assert.ok(
    await page.locator('.work-area').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await page.screenshot({ path: 'artifacts/41-terminal-lateral.png' });
  await assert.rejects(call({ type: 'renameProject', projectId: original.id, name: ' ' }));
  await app.close();
  app = undefined;
  await launch();
  const restored = await snap();
  assert.equal(restored.projects.find((p) => p.id === original.id).name, 'Landing web');
  assert.equal(restored.projects.find((p) => p.id === original.id).path, folders[0]);
  assert.equal(restored.sessions.find((s) => s.id === first).title, 'Revisar estilos');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.right-terminal .xterm').waitFor();
  await page.getByRole('button', { name: 'Mover terminal abajo', exact: true }).click();
  await page.locator('.bottom-terminal .xterm').waitFor();
  for (const folder of folders) assert.deepEqual(await fs.readdir(folder), []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: aligned hover add, overflow-only search, double-click folding, F2 project/chat rename including inactive selection, Enter/Escape/blur/empty behavior, persistent metadata only, bottom PTY/cwd/buffer retention; project folders unchanged.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
