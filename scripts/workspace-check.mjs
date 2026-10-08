import { createTestAccounts } from './test-accounts.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-workspace-')));
const folder = path.join(root, 'Proyecto de prueba');
await fs.mkdir(folder);
execFileSync('git', ['init', '-q', folder]);
await fs.writeFile(path.join(folder, 'nota.txt'), 'Prueba local\n');
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snap = () => call({ type: 'snapshot' });
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(100);
  }
  throw new Error('Timeout');
}
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
  await page.locator('.chat-watermark').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Abrir agente', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Detener agente', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Chat', exact: true }).count(), 0);
  assert.equal(await page.getByText('¿Qué construimos?', { exact: true }).count(), 0);
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/30-chat-marca-agua.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await until(async () => (await snap()).terminals?.length === 1);
  const p = (await snap()).projects[0];
  const terminalId = `shell:${p.id}`;
  await call({
    type: 'terminalWrite',
    sessionId: terminalId,
    data: "printf '\\nAD_PTY_OK\\n'; pwd\r",
  });
  await until(async () =>
    (await call({ type: 'terminalBuffer', sessionId: terminalId })).data.includes(folder),
  );
  await page.getByRole('button', { name: 'Cambios de Git', exact: true }).click();
  await page.getByText('nota.txt', { exact: false }).first().waitFor();
  // Opening a side panel from inside the chat must preserve Chromium's layout tree.
  assert.ok(await page.locator('.composer').boundingBox());
  assert.ok(await page.locator('.session-tabs-bar').boundingBox());
  const counters = page.getByRole('button', { name: /^Ver cambios:/ });
  await counters.waitFor();
  await counters.click();
  assert.equal(await page.locator('.diff-panel').count(), 0);
  await counters.click();
  await page.locator('.diff-panel').waitFor();
  assert.ok(await page.locator('.composer').boundingBox());

  const term = await page.locator('.terminal-pane').boundingBox();
  const diff = await page.locator('.diff-panel').boundingBox();
  assert.ok(term.y >= diff.y + diff.height && term.width > diff.width);
  await page.screenshot({ path: 'artifacts/31-terminal-git-dividido.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Plegar proyectos' }).click();
  await page.setViewportSize({ width: 900, height: 620 });
  await page.screenshot({ path: 'artifacts/32-terminal-git-compacto.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  assert.equal((await snap()).terminals.length, 1);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await until(async () => (await page.locator('.xterm').count()) === 1);
  assert.ok(
    (await call({ type: 'terminalBuffer', sessionId: terminalId })).data.includes('AD_PTY_OK'),
  );
  // First send starts Codex. Without auth it must preserve the draft and require official login.
  await page.getByRole('combobox', { name: 'Cuenta del chat' }).selectOption('codex');
  await until(async () => {
    const s = await snap();
    return s.sessions.find((x) => x.id === s.selectedSession)?.profile === 'codex';
  });
  await page.waitForTimeout(200);
  const input = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await input.fill('Comprueba este proyecto');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await page.getByRole('button', { name: 'Gestionar cuenta en Ajustes', exact: true }).waitFor();
  await until(async () => (await input.inputValue()) === 'Comprueba este proyecto');
  assert.equal((await snap()).sessions.find((s) => s.profile === 'codex').status, 'ready');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: watermark, absent lifecycle/mode controls, actual project PTY and cwd, retained buffer, bottom terminal with side Git, 900px layout, Codex first-send startup and auth failure preserves draft.',
  );
} finally {
  if (app) await app.close();
}
