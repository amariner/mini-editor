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
  const plus = await page
    .getByRole('button', { name: 'Añadir proyecto', exact: true })
    .boundingBox();
  const search = page.getByRole('button', { name: 'Buscar proyectos y sesiones' });
  const sb = await search.boundingBox();
  assert.ok(plus.x < sb.x && Math.abs(plus.y - sb.y) < 1 && plus.x < 35);
  await search.click();
  await page.getByPlaceholder('Buscar proyecto o sesión…').waitFor();
  await page.keyboard.press('Escape');
  // Double click an inactive project; selection must not swallow the second click.
  await page.getByRole('button', { name: 'Proyecto uno', exact: true }).dblclick();
  let input = page.getByRole('textbox', { name: 'Nombre del proyecto', exact: true });
  await input.fill('Landing');
  await input.press('Enter');
  await until(async () => (await snap()).projects.some((p) => p.name === 'Landing'));
  const original = (await snap()).projects.find((p) => p.name === 'Landing');
  assert.equal(original.path, folders[0]);
  assert.equal((await fs.stat(folders[0])).isDirectory(), true);
  await page.getByRole('button', { name: 'Landing', exact: true }).dblclick();
  await input.fill('Cancelar');
  await input.press('Escape');
  assert.equal((await snap()).projects.find((p) => p.id === original.id).name, 'Landing');
  await page.getByRole('button', { name: 'Landing', exact: true }).dblclick();
  await input.fill('   ');
  await input.press('Enter');
  assert.equal((await snap()).projects.find((p) => p.id === original.id).name, 'Landing');
  await page.getByRole('button', { name: 'Plegar proyectos' }).click();
  assert.equal(await search.count(), 0);
  await page.getByRole('button', { name: 'Landing', exact: true }).dblclick();
  await input.fill('Landing web');
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  await until(
    async () => (await snap()).projects.find((p) => p.id === original.id).name === 'Landing web',
  );
  const first = (await snap()).selectedSession;
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
  await page.getByRole('tab', { name: 'Sesión 2', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Sesión 1', exact: true }).dblclick();
  const title = page.getByRole('textbox', { name: 'Nombre del chat', exact: true });
  await title.fill('Revisar estilos');
  await title.press('Enter');
  await until(
    async () => (await snap()).sessions.find((s) => s.id === first).title === 'Revisar estilos',
  );
  await page.getByRole('tab', { name: 'Revisar estilos', exact: true }).dblclick();
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
  await assert.rejects(call({ type: 'renameProject', projectId: original.id, name: ' ' }));
  await app.close();
  app = undefined;
  await launch();
  const restored = await snap();
  assert.equal(restored.projects.find((p) => p.id === original.id).name, 'Landing web');
  assert.equal(restored.projects.find((p) => p.id === original.id).path, folders[0]);
  assert.equal(restored.sessions.find((s) => s.id === first).title, 'Revisar estilos');
  for (const folder of folders) assert.deepEqual(await fs.readdir(folder), []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: left +/search, collapsed search hidden, inline project/chat rename including inactive selection, Enter/Escape/blur/empty behavior, persistent metadata only, bottom PTY/cwd/buffer retention; project folders unchanged.',
  );
} finally {
  await app?.close();
}
