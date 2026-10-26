// Renderer fixture test for Settings → Interfaz: theme switch and the user CSS editor.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
// Compare with the actual runtime imports so new components cannot silently go missing.
const mainSource = await fs.readFile('src/main.tsx', 'utf8');
// Component-owned styles are evaluated before the shell imports. Keep their first
// occurrence: chat-navigation is also imported by main but applied only once.
const sources = [
  ...new Set([
    'src/chat-details.css',
    'src/chat-state-mark.css',
    'src/chat-detach-drag.css',
    'src/chat-navigation.css',
    'src/git-dock.css',
    ...[...mainSource.matchAll(/^import '([^']+\.css)';$/gm)].map(([, file]) =>
      file.startsWith('.') ? path.join('src', file) : path.join('node_modules', file),
    ),
  ]),
];
const expectedBase = (await Promise.all(sources.map((file) => fs.readFile(file, 'utf8')))).join(
  '\n\n',
);
const testBuild = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-interface-'))
  : undefined;
if (testBuild) await build({ build: { outDir: testBuild, emptyOutDir: true }, logLevel: 'silent' });
const server = await preview({
  build: { outDir: testBuild ?? 'dist' },
  preview: { host: '127.0.0.1', port: 0 },
  logLevel: 'silent',
});
const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
let browser, page;
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((protocol) => {
    const state = {
      theme: 'system',
      profiles: [{ id: 'claude-1', name: 'Personal', kind: 'claude' }],
      accounts: {},
      projects: [{ id: 'p', name: 'Proyecto', path: '/tmp/interface-fixture' }],
      sessions: [
        {
          id: 's',
          projectId: 'p',
          profile: 'claude-1',
          title: 'Nueva',
          status: 'ready',
          mode: 'chat',
          approvals: [],
          messages: [],
        },
      ],
      selectedSession: 's',
      selectedProject: 'p',
      tools: {},
      dataDir: '/tmp/interface-fixture',
      runtime: { protocol },
      coordination: [],
    };
    const listeners = new Set();
    window.fixture = {
      actions: [],
      emit(event) {
        for (const fn of listeners) fn(event);
      },
    };
    window.desk = {
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async invoke(action) {
        window.fixture.actions.push(action);
        if (action.type === 'setTheme') state.theme = action.theme;
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'diff') return { repository: false };
        return true;
      },
    };
  }, protocol);
  const brand = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    );
  const sendRadius = () =>
    page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.workspace .desk-input .send'))
          .borderTopLeftRadius,
    );
  const openInterface = async () => {
    await page.keyboard.press('Meta+,');
    await page.getByRole('tab', { name: 'Interfaz', exact: true }).click();
    await page.locator('summary').filter({ hasText: 'Temas y CSS' }).click();
  };
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.desk-input').waitFor();
  const original = await brand();
  const originalRadius = await sendRadius();
  assert.equal(original, '#9eaaf3');
  await openInterface();
  // Theme: three choices, the selection goes to the main process.
  const dark = page.getByRole('radio', { name: 'Oscuro', exact: true });
  assert.equal(
    await page.getByRole('radio', { name: 'Sistema', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/interfaz-ajustes.png' });
  await dark.click();
  await page.waitForFunction(() =>
    window.fixture.actions.some((a) => a.type === 'setTheme' && a.theme === 'dark'),
  );
  assert.equal(await dark.getAttribute('aria-checked'), 'true');
  // CSS editor: full editor stylesheet, edited and saved.
  const editor = page.getByRole('textbox', { name: 'CSS del editor', exact: true });
  await page.waitForFunction(() =>
    document.querySelector('.style-editor textarea')?.value.includes('--brand'),
  );
  await editor.scrollIntoViewIfNeeded();
  const css = await editor.inputValue();
  const firstDifference = [...css].findIndex(
    (character, index) => character !== expectedBase[index],
  );
  assert.ok(
    css === expectedBase,
    `debe incluir todas las fuentes CSS, en el orden de aplicación (primera diferencia en ${firstDifference}, actual ${css.length}, esperado ${expectedBase.length})`,
  );
  assert.equal(await page.locator('.style-state').innerText(), 'Estilos originales');
  // A fixture clipboard exercises the paste event without reading or changing the system clipboard.
  await editor.focus();
  await editor.evaluate((el, text) => {
    el.setSelectionRange(17, 35);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text.replace(/\n/g, '\r\n'));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  }, css);
  const pasted = css.slice(0, 17) + css + css.slice(35);
  assert.ok(
    (await editor.inputValue()) === pasted,
    'multiline paste must replace only the selection and normalize line endings',
  );
  assert.equal(await editor.evaluate((el) => el.selectionStart), 17 + css.length);
  await editor.press('Meta+z');
  assert.ok((await editor.inputValue()) === css);
  assert.deepEqual(await editor.evaluate((el) => [el.selectionStart, el.selectionEnd]), [17, 35]);
  await editor.press('Meta+Shift+z');
  assert.ok((await editor.inputValue()) === pasted);
  await editor.press('Meta+z');
  assert.ok((await editor.inputValue()) === css);
  const changedCss = css.replace('--brand: #9eaaf3;', '--brand: #ff3366;');
  await editor.fill(changedCss, { timeout: 5000 });
  await editor.press('Meta+z');
  assert.ok(
    (await editor.inputValue()) === css,
    'undo must restore the complete stylesheet after bulk replacement',
  );
  await editor.press('Meta+Shift+z');
  assert.ok((await editor.inputValue()) === changedCss, 'redo must restore the bulk edit');
  const colorStart = changedCss.indexOf('#ff3366');
  await editor.evaluate((el, start) => el.setSelectionRange(start, start + 7), colorStart);
  await page.keyboard.insertText('#35c997');
  assert.ok((await editor.inputValue()).includes('--brand: #35c997;'));
  assert.equal(await editor.evaluate((el) => el.selectionStart), colorStart + 7);
  await editor.press('Meta+z');
  assert.ok(
    (await editor.inputValue()) === changedCss,
    'undo must preserve small edits inside a large stylesheet',
  );
  assert.equal(await page.locator('.style-state').innerText(), 'Cambios sin guardar');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  assert.equal(await brand(), '#ff3366');
  assert.equal(await page.locator('.style-state').innerText(), 'Usando tus estilos');
  const quickStyle = page.getByRole('combobox', { name: 'Estilo', exact: true });
  assert.equal(await quickStyle.inputValue(), 'custom');
  await quickStyle.focus();
  assert.ok(await quickStyle.evaluate((element) => element === document.activeElement));
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/interfaz-css.png' });
  // Saved styles survive a restart and apply before the first paint.
  await page.reload();
  await page.locator('.desk-input').waitFor();
  assert.equal(await brand(), '#ff3366');
  // Reset brings the original styles back.
  await openInterface();
  await page.getByRole('button', { name: 'Restablecer', exact: true }).last().click();
  assert.equal(await brand(), original);
  assert.equal(await page.evaluate(() => localStorage.getItem('agent-desk.styles.v1')), null);
  assert.ok((await editor.inputValue()).includes('--brand: #9eaaf3;'));
  // A partial paste only overrides what it mentions.
  await editor.fill('.app .desk-input .send { border-radius: 50%; }');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  assert.equal(await sendRadius(), '50%');
  assert.equal(await brand(), original);
  // Text without CSS rules is rejected and changes nothing.
  await editor.fill('hola mundo');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  assert.match(await page.locator('.style-notice').innerText(), /No se ha reconocido/);
  assert.equal(await sendRadius(), '50%');
  // Window → Restablecer estilos de la interfaz (native menu) always recovers.
  await page.evaluate(() => window.fixture.emit({ type: 'shortcut', action: 'resetStyles' }));
  assert.equal(await sendRadius(), originalRadius);
  await page.waitForFunction(
    () => document.querySelector('.style-state')?.textContent === 'Estilos originales',
    null,
    { timeout: 3000 },
  );
  await page.screenshot({ path: 'artifacts/interfaz-tema.png' });
  // Themes: a shipped one, a saved one, updates, switching and deletion.
  const picker = page.locator('#style-theme');
  const state = (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.style-state')?.textContent === text,
      text,
      { timeout: 3000 },
    );
  assert.deepEqual(await picker.locator('optgroup[label="Incluidos"] option').allTextContents(), [
    'Grafito',
    'Noche',
    'Papel',
    'Ultraminimalista',
  ]);
  for (const [name, accent, scheme] of [
    ['Grafito', '#c5ab78', 'dark'],
    ['Papel', '#55694f', 'light'],
  ]) {
    await picker.selectOption({ label: name });
    await state(`Tema: ${name}`);
    assert.equal(await brand(), accent);
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      scheme,
    );
    await page.emulateMedia({ colorScheme: scheme === 'dark' ? 'light' : 'dark' });
    assert.equal(await brand(), accent);
    await page.waitForFunction(
      (expected) => getComputedStyle(document.querySelector('.modal')).backgroundColor === expected,
      name === 'Papel' ? 'rgb(246, 243, 235)' : 'rgb(37, 37, 35)',
    );
    await page.screenshot({ path: `artifacts/tema-${name.toLowerCase()}.png` });
    await page.reload();
    await page.locator('.desk-input').waitFor();
    assert.equal(await brand(), accent);
    await openInterface();
    await state(`Tema: ${name}`);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await picker.selectOption({ label: 'Noche' });
  await state('Tema: Noche');
  assert.equal(await brand(), '#9aafc2');
  assert.match(await editor.inputValue(), /Noche/);
  await page.screenshot({ path: 'artifacts/interfaz-temas.png' });
  await picker.selectOption({ label: 'Ultraminimalista' });
  await state('Tema: Ultraminimalista');
  assert.equal(await brand(), '#ebebeb');
  assert.match(await editor.inputValue(), /TEMA ULTRAMINIMALISTA/);
  await page.screenshot({ path: 'artifacts/interfaz-temas.png' });
  await editor.fill((await editor.inputValue()).replace('--brand: #ebebeb;', '--brand: #ff3366;'));
  await page.getByRole('button', { name: 'Guardar como tema…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nombre del tema', exact: true }).fill('Mi neón');
  await page.getByRole('button', { name: 'Guardar tema', exact: true }).click();
  await state('Tema: Mi neón');
  assert.equal(await brand(), '#ff3366');
  assert.equal(await picker.locator('optgroup[label="Tus temas"] option').innerText(), 'Mi neón');
  // The active theme survives a restart.
  await page.reload();
  await page.locator('.desk-input').waitFor();
  assert.equal(await brand(), '#ff3366');
  await openInterface();
  await state('Tema: Mi neón');
  // Saving while a theme of yours is active updates that theme.
  await editor.fill((await editor.inputValue()).replace('--brand: #ff3366;', '--brand: #00ffaa;'));
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await state('Tema: Mi neón');
  assert.equal(await brand(), '#00ffaa');
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('agent-desk.themes.v1')),
  );
  assert.equal(stored.length, 1);
  assert.match(stored[0].css, /--brand: #00ffaa;/);
  // Switching themes applies them at once; Original removes custom styles.
  await picker.selectOption('');
  await state('Estilos originales');
  assert.equal(await brand(), original);
  await picker.selectOption({ label: 'Noche' });
  await state('Tema: Noche');
  assert.equal(await brand(), '#9aafc2');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await brand(), '#9aafc2');
  await page.reload();
  await page.locator('.desk-input').waitFor();
  assert.equal(await brand(), '#9aafc2');
  await openInterface();
  await state('Tema: Noche');
  await page.emulateMedia({ colorScheme: 'dark' });
  await picker.selectOption('');
  await state('Estilos originales');
  assert.equal(await brand(), original);
  await picker.selectOption({ label: 'Mi neón' });
  await state('Tema: Mi neón');
  assert.equal(await brand(), '#00ffaa');
  // Same name replaces instead of duplicating.
  await page.getByRole('button', { name: 'Guardar como tema…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nombre del tema', exact: true }).press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Ajustes' }).count(), 1);
  await page.getByRole('button', { name: 'Guardar como tema…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nombre del tema', exact: true }).fill('MI NEÓN');
  await page.getByRole('button', { name: 'Guardar tema', exact: true }).click();
  await state('Tema: MI NEÓN');
  assert.equal(
    (await page.evaluate(() => JSON.parse(localStorage.getItem('agent-desk.themes.v1')))).length,
    1,
  );
  // Deleting the active theme brings the original styles back.
  await page.getByRole('button', { name: 'Eliminar', exact: true }).click();
  await state('Estilos originales');
  assert.equal(await brand(), original);
  assert.equal(await picker.locator('optgroup[label="Tus temas"]').count(), 0);
  assert.equal(
    await page.getByRole('button', { name: 'Eliminar', exact: true }).isDisabled(),
    true,
  );
  // The compact style selector remains usable after custom CSS and in a small window.
  await quickStyle.selectOption('builtin:ultraminimalista');
  await state('Tema: Ultraminimalista');
  await page.reload();
  await page.locator('.desk-input').waitFor();
  await openInterface();
  assert.equal(await quickStyle.inputValue(), 'builtin:ultraminimalista');
  await page.setViewportSize({ width: 400, height: 520 });
  await quickStyle.scrollIntoViewIfNeeded();
  assert.ok(
    await quickStyle.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const dialog = element.closest('[role="dialog"]');
      return (
        box.left >= 0 && box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth + 1
      );
    }),
  );
  await quickStyle.selectOption('');
  await state('Estilos originales');
  assert.equal(await brand(), original);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: tema Sistema/Claro/Oscuro, CSS completo copiable, guardar, recarga, parcial, inválido, restablecer y temas guardados.',
  );
} catch (error) {
  console.error(String(error.message).split('Call log:')[0]);
  console.error(
    String(error.stack)
      .split('\n')
      .filter((line) => line.includes('scripts/interface-check.mjs'))
      .join('\n'),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
