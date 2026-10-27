// Appearance checks use isolated app data and never send agent prompts.
import { _electron as electron } from 'playwright';
import { createTestAccounts } from './test-accounts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-glass-'));
const errors = [];
let app;
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
  const page = await app.firstWindow();
  const call = (target, action) => target.evaluate((a) => window.desk.invoke(a), action);
  await page.waitForFunction(() => !!window.desk);
  await createTestAccounts(page);
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, root);
  await call(page, { type: 'addProject' });
  const session = (await call(page, { type: 'snapshot' })).sessions[0];
  const opened = app.waitForEvent('window');
  await call(page, { type: 'floatingChat', sessionId: session.id, operation: 'open' });
  const floating = await opened;
  floating.on('pageerror', (error) => errors.push(error.message));
  await floating.locator('.floating-chat-header').waitFor();
  assert.equal(await floating.getByRole('button', { name: 'Detalles del chat', exact: true }).count(), 0);
  const drag = await floating.getByRole('img', { name: 'Mover ventana', exact: true }).evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
    region: getComputedStyle(el).getPropertyValue('-webkit-app-region'),
    controls: getComputedStyle(document.querySelector('.floating-chat-controls')).getPropertyValue('-webkit-app-region'),
  }));
  assert.ok(drag.width >= 24 && drag.height >= 24, 'Visible drag handle needs a usable area');
  assert.equal(drag.region, 'drag');
  assert.equal(drag.controls, 'no-drag');

  await floating.getByRole('button', { name: 'Opciones de ventana flotante', exact: true }).click();
  await floating.locator('#floating-opacity').fill('45');
  assert.equal(
    await floating
      .locator(
        '.floating-opacity-presets, .floating-material-picker, .floating-close, .floating-chat-options p',
      )
      .count(),
    0,
  );
  if (process.platform === 'darwin') {
    await floating.locator('#floating-glass-strength').fill('0');
    await floating.waitForFunction(
      () => document.querySelector('.app').dataset.floatingMaterial === 'clear',
    );
  }
  if (process.platform === 'darwin') {
    await floating.locator('#floating-glass-strength').fill('200');
    await floating.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.app'))
          .getPropertyValue('--floating-glass-strength')
          .trim() === '2',
    );
    const effect = await floating
      .locator('.app')
      .evaluate((el) => getComputedStyle(el, '::before').backgroundImage);
    assert.notEqual(effect, 'none');
    // Older preferences may disable the glass while retaining a nonzero intensity.
    await call(floating, {
      type: 'floatingChat',
      sessionId: session.id,
      operation: 'configure',
      glass: false,
    });
    await floating.waitForFunction(
      () => document.querySelector('#floating-glass-strength')?.value === '0',
    );
    assert.equal(await floating.locator('output[for="floating-glass-strength"]').innerText(), '0%');
    await floating.locator('#floating-glass-strength').fill('200');
  }
  assert.equal(await floating.locator('.composer-footer').isVisible(), false);
  if (process.platform === 'darwin') {
    const blur = floating.locator('#floating-blur');
    await blur.click();
    assert.equal(
      (await call(floating, { type: 'snapshot' })).floatingChats.find(
        (f) => f.sessionId === session.id,
      ).blur,
      true,
    );
    await blur.click();
    assert.equal(
      (await call(floating, { type: 'snapshot' })).floatingChats.find(
        (f) => f.sessionId === session.id,
      ).blur,
      false,
    );
    const settings = (await call(floating, { type: 'snapshot' })).floatingChats.find(
      (f) => f.sessionId === session.id,
    );
    assert.equal(settings.opacity, 0.45, 'Blur preserves the independent tint');
    assert.equal(settings.glassStrength, 2, 'Blur preserves the independent glass intensity');
  }
  await floating.locator('#floating-opacity').fill('0');
  await floating.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.app'))
        .getPropertyValue('--floating-effective-opacity')
        .trim() === '0%',
  );
  await floating.locator('#floating-opacity').fill('1');
  await floating.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.app'))
        .getPropertyValue('--floating-effective-opacity')
        .trim() === '1%',
  );
  await floating.locator('#floating-opacity').fill('45');
  await fs.mkdir('artifacts', { recursive: true });
  await floating.screenshot({ path: 'artifacts/floating-appearance-options.png' });
  await floating.keyboard.press('Escape');
  const composerGeometry = () =>
    floating.locator('.composer').evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        padding: style.padding,
        radius: style.borderRadius,
        background: style.backgroundColor,
      };
    });
  await floating.getByRole('button', { name: 'Opciones de ventana flotante', exact: true }).focus();
  await floating.waitForTimeout(350);
  const restingComposer = await composerGeometry();
  await floating.getByRole('textbox', { name: 'Mensaje', exact: true }).focus();
  await floating.waitForTimeout(300);
  assert.deepEqual(
    await composerGeometry(),
    restingComposer,
    'Focusing the composer preserves its geometry and surface',
  );

  await floating
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Escribe sobre el cristal…');
  await floating.waitForTimeout(350);
  const alignment = await floating.locator('.composer-bar').evaluate((bar) => {
    const tools = bar.querySelector('.tools-toggle').getBoundingClientRect();
    const send = bar.querySelector('.send').getBoundingClientRect();
    return {
      offset: Math.abs(tools.y + tools.height / 2 - send.y - send.height / 2),
      sameSize: tools.width === send.width && tools.height === send.height,
    };
  });
  assert.ok(alignment.offset < 1 && alignment.sameSize, JSON.stringify(alignment));
  await floating
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Primera línea\nSegunda línea\nTercera línea');
  await floating.getByRole('button', { name: 'Opciones de ventana flotante', exact: true }).focus();
  const multilineComposer = await composerGeometry();
  await floating.getByRole('textbox', { name: 'Mensaje', exact: true }).focus();
  await floating.waitForTimeout(200);
  assert.deepEqual(
    await composerGeometry(),
    multilineComposer,
    'Multiline focus preserves geometry',
  );
  await floating.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
  const toolsComposer = await composerGeometry();
  await floating.getByRole('textbox', { name: 'Mensaje', exact: true }).focus();
  assert.deepEqual(
    await composerGeometry(),
    toolsComposer,
    'Open tools preserve geometry on focus',
  );
  await floating.getByRole('button', { name: 'Ocultar herramientas', exact: true }).click();
  const style = await floating.locator('.app').evaluate((el) => ({
    background: getComputedStyle(el).backgroundColor,
    border: getComputedStyle(el).borderColor,
    textOpacity: getComputedStyle(document.querySelector('textarea')).opacity,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.match(style.background, /0\.45\)/);
  assert.equal(style.textOpacity, '1');
  assert.equal(style.overflow, false);
  for (const theme of ['dark', 'light']) {
    await call(floating, { type: 'setTheme', theme });
    // Playwright's default light emulation masks Electron's native theme selection.
    await floating.emulateMedia({ colorScheme: theme });
    await floating.waitForFunction(
      (dark) => matchMedia('(prefers-color-scheme: dark)').matches === dark,
      theme === 'dark',
    );
    await floating.waitForTimeout(300);
    await floating.screenshot({ path: `artifacts/floating-appearance-${theme}.png` });
  }
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes(id))
      .setSize(340, 360);
  }, session.id);
  await floating.waitForFunction(() => innerWidth === 340 && innerHeight === 360);
  for (const width of [340, 460, 520]) {
    await app.evaluate(({ BrowserWindow }, { id, width }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(id)).setSize(width, 580);
    }, { id: session.id, width });
    await floating.waitForFunction((width) => innerWidth === width, width);
    for (const text of ['', 'Mensaje de prueba', 'Primera línea\nSegunda línea']) {
      await floating.getByRole('textbox', { name: 'Mensaje', exact: true }).fill(text);
      const geometry = await floating.locator('.composer').evaluate((composer) => {
        const rect = composer.getBoundingClientRect();
        const area = composer.querySelector('textarea').getBoundingClientRect();
        const bar = composer.querySelector('.composer-bar').getBoundingClientRect();
        return {
          fullWritingRow: area.width >= rect.width - 32 && area.bottom <= bar.top + 1,
          controlsFit: [...composer.querySelectorAll('.composer-bar button:not(.composer-extras button)')]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .every((el) => { const r = el.getBoundingClientRect(); return r.left >= rect.left && r.right <= rect.right + 1; }),
        };
      });
      assert.ok(geometry.fullWritingRow, `Writing row at ${width}px: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.controlsFit, `Controls overflow at ${width}px`);
    }
    await floating.screenshot({ path: `artifacts/floating-composer-${width}.png` });
  }
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(id)).setSize(340, 360);
  }, session.id);
  await floating.waitForFunction(() => innerWidth === 340 && innerHeight === 360);
  await floating.getByRole('button', { name: 'Opciones de ventana flotante', exact: true }).click();
  await floating.waitForTimeout(200);
  const compactLayout = await floating.evaluate(() => {
    const header = document.querySelector('.floating-chat-header').getBoundingClientRect();
    const popup = document.querySelector('.floating-chat-options').getBoundingClientRect();
    return {
      headerHeight: header.height,
      popupFits:
        popup.top >= header.bottom && popup.bottom <= innerHeight && popup.right <= innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.equal(compactLayout.headerHeight, 32);
  assert.equal(compactLayout.popupFits, true, 'Appearance controls fit the minimum window size');
  assert.equal(compactLayout.overflow, false);
  // Both material and tint survive closing and reopening the native window.
  const closed = floating.waitForEvent('close');
  await call(floating, { type: 'floatingChat', sessionId: session.id, operation: 'close' });
  await closed;
  const reopened = app.waitForEvent('window');
  await call(page, { type: 'floatingChat', sessionId: session.id, operation: 'open' });
  const restored = await reopened;
  await restored.locator('.floating-chat-header').waitFor();
  const saved = (await call(restored, { type: 'snapshot' })).floatingChats.find(
    (f) => f.sessionId === session.id,
  );
  assert.equal(saved.opacity, 0.45);
  assert.equal(saved.glass, true);
  assert.equal(saved.blur, false);
  if (process.platform === 'darwin') assert.equal(saved.glassStrength, 2);
  await call(restored, { type: 'floatingChat', sessionId: session.id, operation: 'dock' });
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  const card = page.locator('.multichat-card').first();
  await card.locator('textarea').fill('Borrador sin enviar');
  for (const color of ['#001908', '#ffffff']) {
    await call(page, { type: 'setAccountColor', profile: session.profile, color });
    await page.waitForTimeout(100);
    const contrast = await card.locator('button[type="submit"]').evaluate((button) => ({
      background: getComputedStyle(button).backgroundColor,
      icon: getComputedStyle(button.querySelector('svg')).color,
      ink: getComputedStyle(button).color,
      visible: button.querySelector('svg').getBoundingClientRect().width > 0,
    }));
    assert.notEqual(contrast.background, contrast.icon, 'Send icon must contrast with its surface');
    assert.equal(contrast.icon, contrast.ink, 'Account icon colours must not override send contrast');
    assert.equal(contrast.visible, true);
  }
  await page.screenshot({ path: 'artifacts/grid-send-contrast.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Floating appearance: independent effects, compact controls, stable composer focus, themes and persistence OK.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
