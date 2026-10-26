import { createTestAccounts } from './test-accounts.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-workspace-')));
const folder = path.join(root, 'Proyecto de prueba');
await fs.mkdir(folder);
execFileSync('git', ['init', '-q', folder]);
await fs.writeFile(path.join(folder, 'nota.txt'), 'Prueba local\n');
// Give the diff real changed lines; zero-line counters are intentionally omitted.
execFileSync('git', ['-C', folder, 'add', '--intent-to-add', 'nota.txt']);
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
      AGENT_DESK_DEV_URL: process.env.SOURCE_DEV_URL ?? '',
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
  await page.locator('.sidebar').hover();
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
  const git = page.getByRole('button', { name: 'Gestionar ramas y Git', exact: true });
  await git.click();
  await page.getByRole('button', { name: 'Ver diferencias', exact: true }).click();
  await page.locator('.diff-panel').getByText('nota.txt', { exact: false }).first().waitFor();
  // Opening a side panel from inside the chat must preserve Chromium's layout tree.
  assert.ok(await page.locator('.composer').boundingBox());
  assert.ok(await git.boundingBox());
  assert.equal(await page.locator('.session-tabs-bar').count(), 0);
  const counters = page.getByRole('button', { name: /^Ver cambios:/ });
  await git.click();
  await counters.waitFor();
  await counters.click();
  await page.locator('.diff-panel').waitFor({ state: 'detached' });
  await git.click();
  await counters.click();
  await page.locator('.diff-panel').waitFor();
  assert.ok(await page.locator('.composer').boundingBox());

  const term = await page.locator('.terminal-pane').boundingBox();
  const diff = await page.locator('.diff-panel').boundingBox();
  assert.ok(term.y >= diff.y + diff.height && term.width > diff.width);
  await page.screenshot({ path: 'artifacts/31-terminal-git-dividido.png', animations: 'disabled' });
  await page.keyboard.press('ControlOrMeta+b');
  await page.setViewportSize({ width: 900, height: 620 });
  await page.screenshot({ path: 'artifacts/32-terminal-git-compacto.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // In compact layouts the side panel floats over the composer controls.
  await page.getByRole('button', { name: 'Cerrar panel de trabajo', exact: true }).click();
  await page.locator('.workspace-panel').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  assert.equal(await page.locator('.terminal-pane').count(), 0);
  assert.equal((await snap()).terminals.length, 1);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await until(async () => (await page.locator('.xterm').count()) === 1);
  assert.ok(
    (await call({ type: 'terminalBuffer', sessionId: terminalId })).data.includes('AD_PTY_OK'),
  );
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();

  // A project opened below the checkout root must share Git-relative paths across all views.
  const subproject = path.join(folder, 'app');
  await fs.mkdir(path.join(subproject, 'src'), { recursive: true });
  await fs.writeFile(path.join(subproject, 'src/main.ts'), 'export const panel = "IPC_REAL";\n');
  await fs.writeFile(path.join(folder, 'shared.ts'), 'export const shared = true;\n');
  await fs.writeFile(path.join(folder, 'binary.bin'), Buffer.from([0, 1, 2]));
  await fs.writeFile(path.join(root, 'outside.txt'), 'Never expose this file.\n');
  await fs.symlink(path.join(root, 'outside.txt'), path.join(folder, 'linked.txt'));
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, subproject);
  await call({ type: 'addProject' });
  const state = await snap();
  const selectedProject = state.projects.find((project) => project.path === subproject);
  assert.ok(selectedProject);
  const selectedSession = state.sessions.find((session) => session.id === state.selectedSession);
  assert.equal(selectedSession.projectId, selectedProject.id);
  const base = { projectId: selectedProject.id, sessionId: selectedSession.id };
  const listing = await call({ type: 'workspaceFiles', ...base });
  assert.equal(listing.root, folder);
  assert.ok(listing.entries.some((entry) => entry.path === 'shared.ts'));
  assert.ok(!listing.entries.some((entry) => entry.path === '.git' || entry.path === 'linked.txt'));
  assert.deepEqual(
    (await call({ type: 'workspaceFiles', ...base, directory: 'app/src' })).entries.map(
      (entry) => entry.path,
    ),
    ['app/src/main.ts'],
  );
  for (const reference of [
    'app/src/main.ts',
    `${path.join(subproject, 'src/main.ts')}:1:1`,
    `${pathToFileURL(path.join(subproject, 'src/main.ts')).href}#L1`,
  ]) {
    const file = await call({ type: 'workspaceFile', ...base, path: reference });
    assert.equal(file.path, 'app/src/main.ts');
    assert.match(file.content, /IPC_REAL/);
  }
  await assert.rejects(
    call({ type: 'workspaceFile', ...base, path: path.join(root, 'outside.txt') }),
    /fuera del proyecto/,
  );
  await assert.rejects(
    call({ type: 'workspaceFile', ...base, path: 'linked.txt' }),
    /enlaces simbólicos/,
  );
  await assert.rejects(
    call({
      type: 'workspaceFiles',
      ...base,
      sessionId: state.sessions.find((s) => s.projectId === p.id).id,
    }),
    /pertenece a otro proyecto/,
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Panel de trabajo', exact: true }).click();
  const panel = page.locator('.workspace-panel');
  await panel.getByRole('tab', { name: 'Archivos', exact: true }).click();
  await panel.locator('.workspace-file-row[title="app"]').click();
  await panel.locator('.workspace-file-row[title="app/src"]').click();
  await panel.locator('.workspace-file-row[title="app/src/main.ts"]').click();
  await panel.getByRole('region', { name: 'Contenido de app/src/main.ts', exact: true }).waitFor();
  assert.match(await panel.locator('.workspace-file-viewer').innerText(), /IPC_REAL/);
  await panel.locator('.workspace-directory-up').click();
  await panel.locator('.workspace-file-row[title="app/src"]').waitFor();
  await panel.locator('.workspace-directory-up').click();
  await panel.locator('.workspace-file-row[title="shared.ts"]').waitFor();
  await panel.getByRole('textbox', { name: 'Buscar archivos', exact: true }).fill('shared');
  await panel.locator('.workspace-file-row[title="shared.ts"]').click();
  await panel.getByRole('region', { name: 'Contenido de shared.ts', exact: true }).waitFor();
  await panel.getByRole('textbox', { name: 'Buscar archivos', exact: true }).fill('binary');
  await panel.locator('.workspace-file-row[title="binary.bin"]').click();
  await panel.getByText('Archivo binario', { exact: true }).waitFor();

  await panel.getByRole('tab', { name: /^Cambios/ }).click();
  await panel.locator('.workspace-file-row[title^="app/src/main.ts ·"]').click();
  await panel.getByRole('region', { name: 'Cambios de app/src/main.ts', exact: true }).waitFor();
  assert.match(await panel.locator('.workspace-diff').innerText(), /IPC_REAL/);
  await panel.getByRole('button', { name: 'Preparar archivo', exact: true }).click();
  const stagedNames = () =>
    execFileSync('git', ['-C', folder, 'diff', '--cached', '--name-only'], {
      encoding: 'utf8',
    }).trim();
  await until(async () => stagedNames() === 'app/src/main.ts');
  await panel.getByRole('combobox', { name: 'Cambios a revisar' }).selectOption('staged');
  await panel.getByRole('region', { name: 'Cambios de app/src/main.ts', exact: true }).waitFor();
  assert.match(await panel.locator('.workspace-diff').innerText(), /IPC_REAL/);
  await page.screenshot({ path: 'artifacts/33-workspace-staged-ipc.png', animations: 'disabled' });
  await panel.getByRole('button', { name: 'Ver archivo completo', exact: true }).click();
  await panel.getByRole('region', { name: 'Contenido de app/src/main.ts', exact: true }).waitFor();
  await panel.getByRole('tab', { name: /^Cambios/ }).click();
  await panel.getByRole('button', { name: 'Quitar de preparados', exact: true }).click();
  await until(async () => stagedNames() === '');
  assert.equal(
    await fs.readFile(path.join(subproject, 'src/main.ts'), 'utf8'),
    'export const panel = "IPC_REAL";\n',
  );
  await panel.getByRole('combobox', { name: 'Cambios a revisar' }).selectOption('unstaged');
  await panel.locator('.workspace-file-row[title^="app/src/main.ts ·"]').click();
  await panel.getByRole('region', { name: 'Cambios de app/src/main.ts', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Cerrar panel de trabajo', exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  assert.equal(
    await page
      .getByRole('button', { name: 'Panel de trabajo', exact: true })
      .getAttribute('aria-expanded'),
    'false',
  );
  // No chat turn is sent: this check only uses temporary projects and local IPC/Git/PTY.
  assert.ok((await snap()).sessions.every((session) => session.status === 'stopped'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: actual Electron IPC, animated panel close, project PTY and retained buffer, 900px layout, subproject checkout root, nested file browsing/search/binary preview, safe file references, cross-project session rejection, untracked/staged diffs, individual Git stage/unstage and full-file navigation.',
  );
} finally {
  try {
    if (app) await app.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
