// Real Electron edit menu with isolated fixture data and a temporary renderer build.
import { _electron as electron } from 'playwright';
import { build, preview } from 'vite';
import { build as bundle } from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-css-editor-'));
let app, server;
try {
  const renderer = path.join(temporary, 'renderer');
  await build({ build: { outDir: renderer, emptyOutDir: true }, logLevel: 'silent' });
  await bundle({
    entryPoints: ['electron/edit-menu.ts'],
    outfile: path.join(temporary, 'edit-menu.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  });
  const entry = path.join(temporary, 'main.cjs');
  await fs.writeFile(
    entry,
    `
    const { app, BrowserWindow, Menu } = require('electron');
    const { editHistoryMenu } = require('./edit-menu.cjs');
    app.setPath('userData', ${JSON.stringify(path.join(temporary, 'data'))});
    app.whenReady().then(() => {
      const main = new BrowserWindow({ width: 1100, height: 900 });
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: 'Edición', submenu: editHistoryMenu(() => main.webContents) }
      ]));
      main.loadURL('about:blank');
    });
    app.on('window-all-closed', () => app.quit());
  `,
  );
  server = await preview({
    build: { outDir: renderer },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  app = await electron.launch({ args: [entry] });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  const protocol = Number(
    (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
  );
  await page.addInitScript((protocol) => {
    const state = {
      theme: 'dark',
      profiles: [],
      accounts: {},
      projects: [],
      sessions: [],
      tools: {},
      dataDir: '/tmp/css-editor-fixture',
      runtime: { protocol },
      coordination: [],
    };
    window.desk = {
      subscribe() {
        return () => {};
      },
      async invoke(action) {
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'diff') return { repository: false };
        return true;
      },
    };
  }, protocol);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('tab', { name: 'Interfaz', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Temas y CSS' }).click();
  const editor = page.getByRole('textbox', { name: 'CSS del editor', exact: true });
  await page.waitForFunction(
    () => document.querySelector('.style-editor textarea')?.value.length > 100000,
  );
  const original = await editor.inputValue();
  const changed = original + '\n/* native history regression */';
  await editor.fill(changed, { timeout: 5000 });
  const menu = async (label, target = page) => {
    const nativeWindow = await app.browserWindow(target);
    const id = await nativeWindow.evaluate((window) => window.id);
    await app.evaluate(
      ({ BrowserWindow, Menu, webContents }, { label, id }) => {
        // Background macOS test apps cannot reliably acquire OS focus. Supply the
        // selected target only; the actual menu callback and native editing remain real.
        const focused = webContents.getFocusedWebContents;
        webContents.getFocusedWebContents = () => BrowserWindow.fromId(id).webContents;
        try {
          const item = Menu.getApplicationMenu().items[0].submenu.items.find(
            (item) => item.label === label,
          );
          item.click();
        } finally {
          webContents.getFocusedWebContents = focused;
        }
      },
      { label, id },
    );
  };
  const waitValue = (field, value) =>
    field.evaluate(
      (el, expected) =>
        new Promise((resolve, reject) => {
          const start = performance.now();
          const check = () => {
            if (el.value === expected) return resolve();
            if (performance.now() - start > 3000)
              return reject(new Error('El menú no actualizó el texto'));
            setTimeout(check, 20);
          };
          check();
        }),
      value,
    );
  await menu('Deshacer');
  await waitValue(editor, original);
  await menu('Rehacer');
  await waitValue(editor, changed);
  await editor.evaluate((el) => el.setSelectionRange(8, 17));
  await page.keyboard.insertText('replacement');
  await menu('Deshacer');
  await waitValue(editor, changed);
  assert.deepEqual(await editor.evaluate((el) => [el.selectionStart, el.selectionEnd]), [8, 17]);
  await editor.press('Meta+z');
  await waitValue(editor, original);
  await editor.press('Meta+Shift+z');
  await waitValue(editor, changed);

  // Ordinary controls in the main window still use their native history.
  await page.getByRole('button', { name: 'Guardar como tema…', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Nombre del tema', exact: true });
  await name.fill('Historia nativa');
  await menu('Deshacer');
  await waitValue(name, '');
  await menu('Rehacer');
  await waitValue(name, 'Historia nativa');

  // A browser webContents must remain native even if its page matches our selector.
  await app.evaluate(async ({ BrowserWindow }) => {
    const child = new BrowserWindow({ width: 400, height: 300 });
    await child.loadURL(
      'data:text/html,<div class="style-editor"><textarea aria-label="Web input"></textarea></div>',
    );
    child.focus();
  });
  const childPage = (await app.windows()).at(-1);
  const webInput = childPage.getByRole('textbox', { name: 'Web input' });
  await webInput.evaluate((el) => {
    window.syntheticHistory = 0;
    el.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.key === 'z') {
        window.syntheticHistory++;
        event.preventDefault();
      }
    });
  });
  await webInput.fill('Historial del navegador');
  await menu('Deshacer', childPage);
  await waitValue(webInput, '');
  await menu('Rehacer', childPage);
  await waitValue(webInput, 'Historial del navegador');
  assert.equal(await childPage.evaluate(() => window.syntheticHistory), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: native Edit menu undo/redo for full CSS, small selection and keyboard shortcuts; normal inputs and browser webContents retain native history.',
  );
} finally {
  await app?.close();
  await server?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
