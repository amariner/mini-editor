// Renderer fixture test for Settings → Interfaz: theme switch and the user CSS editor.
import { chromium } from 'playwright';
import { preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
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
      runtime: { protocol: 22 },
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
  });
  const brand = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    );
  const sendRadius = () =>
    page.evaluate(() => getComputedStyle(document.querySelector('.send')).borderTopLeftRadius);
  const openInterface = async () => {
    await page.keyboard.press('Meta+,');
    await page.getByRole('tab', { name: 'Interfaz', exact: true }).click();
  };
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator('.desk-input').waitFor();
  const original = await brand();
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
  const css = await editor.inputValue();
  assert.ok(css.length > 50000, 'debe incluir todo el CSS del editor');
  assert.equal(await page.locator('.style-state').innerText(), 'Estilos originales');
  await editor.fill(css.replace('--brand: #9eaaf3;', '--brand: #ff3366;'));
  assert.equal(await page.locator('.style-state').innerText(), 'Cambios sin guardar');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  assert.equal(await brand(), '#ff3366');
  assert.equal(await page.locator('.style-state').innerText(), 'Usando tus estilos');
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
  await editor.fill('.desk-input .send { border-radius: 50%; }');
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
  assert.equal(await sendRadius(), '8px');
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
  await picker.selectOption({ label: 'Terminal 8-bit' });
  await state('Tema: Terminal 8-bit');
  assert.equal(await brand(), '#ffd23f');
  assert.match(await editor.inputValue(), /TERMINAL 8-BIT/);
  await page.screenshot({ path: 'artifacts/interfaz-temas.png' });
  await editor.fill((await editor.inputValue()).replace('--brand: #ffd23f;', '--brand: #ff3366;'));
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
  assert.deepEqual(errors, []);
  console.log(
    'PASS: tema Sistema/Claro/Oscuro, CSS completo copiable, guardar, recarga, parcial, inválido, restablecer y temas guardados.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
