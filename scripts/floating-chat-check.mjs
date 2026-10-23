// Native Electron windows with isolated data. No agent prompts or real credentials.
import { _electron as electron } from 'playwright';
import { createTestAccounts } from './test-accounts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-floating-'));
const project = path.join(root, 'Proyecto flotante');
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'nota.txt'), 'Adjunto conservado');
const errors = [];
let app;
const call = (page, action) => page.evaluate((a) => window.desk.invoke(a), action);
const snapshot = (page) => call(page, { type: 'snapshot' });
const float = async (page, id) => {
  const opened = app.waitForEvent('window');
  await call(page, { type: 'floatingChat', sessionId: id, operation: 'open' });
  const window = await opened;
  window.on('pageerror', (e) => errors.push(e.message));
  await window.locator('.floating-chat-header').waitFor();
  return window;
};
const windows = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL().includes('#chat='))
      .map((w) => ({
        id: decodeURIComponent(w.webContents.getURL().split('#chat=')[1]),
        visible: w.isVisible(),
        focused: w.isFocused(),
      })),
  );
const visibility = async (visible, count = 2) => {
  let state;
  for (let attempt = 0; attempt < 60; attempt++) {
    state = await windows();
    if (state.length === count && state.every((w) => w.visible === visible)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const native = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      focused: window.isFocused(),
      visible: window.isVisible(),
    })),
  );
  assert.fail(
    `Expected ${count} floating windows visible=${visible}: ${JSON.stringify({ state, native })}`,
  );
};
const focusEditor = async () =>
  app.evaluate(({ BrowserWindow, app }) => {
    const editor = BrowserWindow.getAllWindows().find(
      (w) =>
        (w.webContents.getURL().includes('/dist/index.html') ||
          w.webContents.getURL().startsWith('http://127.0.0.1:')) &&
        !w.webContents.getURL().includes('#chat='),
    );
    // A background macOS app cannot claim keyboard focus with BrowserWindow.focus alone.
    // This helper simulates an explicit user switch to the editor, including activation.
    app.focus({ steal: true });
    editor.show();
    editor.focus();
  });
try {
  app = await electron.launch({
    args: ['.'],
    timeout: 25_000,
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: process.env.SOURCE_DEV_URL ?? '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  let page = await app.firstWindow({ timeout: 25_000 });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  await createTestAccounts(page);
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  await call(page, { type: 'addProject' });
  await call(page, { type: 'setTheme', theme: 'dark' });
  const first = (await snapshot(page)).sessions[0];
  const draft = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await draft.fill('Mi borrador antes de sacar el chat');
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    },
    path.join(project, 'nota.txt'),
  );
  await page.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
  await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).click();
  await page.getByRole('button', { name: 'Quitar nota.txt', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Ocultar herramientas', exact: true }).click();
  const opened = app.waitForEvent('window');
  const chatHandle = page.locator('.project-chat').filter({ hasText: first.title }).first();
  const chatBounds = await chatHandle.boundingBox();
  const sidebarBounds = await page.locator('.sidebar').boundingBox();
  assert.ok(chatBounds && sidebarBounds);
  await page.mouse.move(chatBounds.x + 20, chatBounds.y + chatBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(sidebarBounds.x + sidebarBounds.width + 140, chatBounds.y + 30, {
    steps: 10,
  });
  await page.locator('.chat-detach-preview[data-detach-ready="true"]').waitFor();
  await page.mouse.up();
  const one = await opened;
  one.on('pageerror', (e) => errors.push(e.message));
  await one.locator('.floating-chat-header').waitFor();
  await one.emulateMedia({ colorScheme: 'dark' });
  const text = one.getByRole('textbox', { name: 'Mensaje', exact: true });
  assert.equal(await text.inputValue(), 'Mi borrador antes de sacar el chat');
  await one.getByRole('button', { name: 'Quitar nota.txt', exact: true }).waitFor();
  await page.getByText('Este chat está flotando', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace .composer').count(), 0);
  await text.fill('Editado en la ventana flotante');

  // Opening the same chat twice only focuses the existing window.
  await call(page, { type: 'floatingChat', sessionId: first.id, operation: 'open' });
  assert.equal(app.windows().length, 2);
  const second = await call(page, {
    type: 'newSession',
    projectId: first.projectId,
    profile: first.profile,
  });
  await focusEditor();
  await visibility(false, 1);
  const two = await float(page, second.id);
  await visibility(true);
  assert.equal(app.windows().length, 3);
  await two
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Segundo chat independiente');
  assert.equal(await text.inputValue(), 'Editado en la ventana flotante');
  assert.equal(await one.locator('.floating-chat-title strong').innerText(), first.title);
  assert.equal((await snapshot(page)).selectedSession, second.id);

  // Clicking the editor hides the whole group without closing or changing sessions.
  await focusEditor();
  await visibility(false);
  assert.equal((await snapshot(page)).floatingChats.length, 2);
  await call(page, { type: 'floatingChat', sessionId: first.id, operation: 'focus' });
  await visibility(true);
  assert.equal((await windows()).find((w) => w.focused)?.id, first.id);

  // An unrelated native window exercises the same blur path as switching apps.
  // The group stays visible and must not take focus away from that window.
  const externalId = await app.evaluate(async ({ BrowserWindow }) => {
    const external = new BrowserWindow({ show: false, width: 350, height: 250 });
    await external.loadURL('about:blank');
    external.show();
    external.focus();
    return external.id;
  });
  await visibility(true);
  await focusEditor();
  await visibility(false);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), externalId);
  await visibility(true);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id),
    externalId,
  );
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), externalId);
  await call(page, { type: 'floatingChat', sessionId: first.id, operation: 'focus' });
  await visibility(true);

  // Only native app windows can invoke IPC; a floating window cannot control a sibling.
  await assert.rejects(
    call(one, { type: 'floatingChat', sessionId: second.id, operation: 'close' }),
    /otra conversación/,
  );
  // The options button exposes opacity without requiring a context click.
  const optionsButton = one.getByRole('button', {
    name: 'Opciones de ventana flotante',
    exact: true,
  });
  await optionsButton.click();
  await one.getByRole('button', { name: 'Volver al editor', exact: true }).focus();
  assert.equal(
    await one.getByRole('dialog', { name: 'Opciones de ventana flotante', exact: true }).count(),
    0,
    'the floating options close when keyboard focus returns to the header',
  );
  await optionsButton.click();
  await optionsButton.click();
  assert.equal(
    await one.getByRole('dialog', { name: 'Opciones de ventana flotante', exact: true }).count(),
    0,
  );
  await optionsButton.click();
  await one.locator('#floating-opacity').fill('45');
  await one.waitForFunction(() => document.querySelector('#floating-opacity')?.value === '45');
  if (process.platform === 'darwin') {
    await one.locator('#floating-glass-strength').fill('0');
    await one.waitForFunction(
      () => document.querySelector('.app').dataset.floatingMaterial === 'clear',
    );
    assert.equal(
      (await snapshot(page)).floatingChats.find((f) => f.sessionId === first.id).glass,
      false,
    );
    await one.locator('#floating-glass-strength').fill('100');
    await one.waitForFunction(
      () => document.querySelector('.app').dataset.floatingMaterial === 'glass',
    );
  }
  await one.locator('#floating-opacity').fill('15');
  await one.waitForFunction(() =>
    getComputedStyle(document.querySelector('.app'))
      .getPropertyValue('--floating-effective-opacity')
      .trim()
      .startsWith('15'),
  );
  // The tint eases in; read it once the transition has settled.
  await one.waitForTimeout(400);
  const alpha = await one.evaluate(() => ({
    root: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.querySelector('.composer textarea')).opacity,
    background: getComputedStyle(document.querySelector('.app')).backgroundColor,
    input: getComputedStyle(document.querySelector('.composer')).backgroundColor,
    layers: ['main', '.work-area', '.workspace', '.conversation', '.messages', '.desk-input'].map(
      (selector) => [selector, getComputedStyle(document.querySelector(selector)).backgroundColor],
    ),
  }));
  assert.equal(alpha.root, 'rgba(0, 0, 0, 0)');
  assert.equal(alpha.body, 'rgba(0, 0, 0, 0)');
  assert.equal(alpha.text, '1');
  // The options panel is open, so the window previews the resting tint instead of turning solid.
  assert.match(alpha.background, /0\.15/);
  // The writing area follows the selected transparency.
  assert.match(alpha.input, /0\.15/);
  assert.ok(
    alpha.layers.every(([, color]) => color === 'rgba(0, 0, 0, 0)'),
    JSON.stringify(alpha.layers),
  );
  // CSS saved in the editor immediately reaches an already-open floating window.
  await page.evaluate(() =>
    localStorage.setItem(
      'agent-desk.styles.v1',
      ':root { --floating-opacity: 60%; --floating-solid: 60%; --floating-composer-opacity: 35%; --floating-header-height: 62px; }',
    ),
  );
  await one.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.app'))
        .getPropertyValue('--floating-effective-opacity')
        .trim() === '60%',
  );
  await one.waitForTimeout(400);
  assert.match(
    await one.locator('.app').evaluate((el) => getComputedStyle(el).backgroundColor),
    /0\.6\)/,
  );
  assert.match(
    await one.locator('.composer').evaluate((el) => getComputedStyle(el).backgroundColor),
    /0\.35\)/,
  );
  const popupBounds = await one.locator('.floating-chat-options').boundingBox();
  const headerBounds = await one.locator('.floating-chat-header').boundingBox();
  assert.ok(popupBounds.y >= headerBounds.y + headerBounds.height);
  await one.keyboard.press('Escape');
  await one.getByRole('textbox', { name: 'Mensaje', exact: true }).focus();
  await one.waitForTimeout(400);
  assert.match(
    await one.locator('.app').evaluate((el) => getComputedStyle(el).backgroundColor),
    /0\.6\)/,
  );
  await page.evaluate(() => localStorage.removeItem('agent-desk.styles.v1'));
  await one.waitForFunction(() =>
    getComputedStyle(document.querySelector('.app'))
      .getPropertyValue('--floating-effective-opacity')
      .trim()
      .startsWith('15'),
  );
  await optionsButton.click();
  await one.getByRole('button', { name: 'Siempre encima', exact: false }).click();
  const native = await app.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(id));
    const pinned = window.isAlwaysOnTop();
    window.setBounds({ x: 100, y: 100, width: 380, height: 480 });
    return { pinned, resizable: window.isResizable(), bounds: window.getBounds() };
  }, first.id);
  assert.equal(native.pinned, false);
  assert.equal(native.resizable, true);
  assert.equal(native.bounds.width, 380);
  await one.keyboard.press('Escape');
  await one.waitForTimeout(200);
  const layout = await one.evaluate(() => {
    const composer = document.querySelector('.composer textarea').getBoundingClientRect();
    const writing = document.querySelector('.desk-input').getBoundingClientRect();
    return {
      right: composer.right,
      bottom: composer.bottom,
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      insetLeft: writing.left,
      insetRight: innerWidth - writing.right,
    };
  });
  assert.ok(layout.right <= layout.width && layout.bottom <= layout.height, JSON.stringify(layout));
  assert.equal(layout.overflow, false);
  assert.ok(layout.insetLeft >= 10 && layout.insetRight >= 10, JSON.stringify(layout));
  await fs.mkdir('artifacts', { recursive: true });
  // Render streamed backend snapshots in the actual native renderer, without model calls.
  const fixture = await snapshot(page);
  const fixtureSession = fixture.sessions.find((session) => session.id === first.id);
  fixtureSession.messages = [
    {
      id: 'floating-u',
      role: 'user',
      text: 'Quiero seguir conversando mientras reviso la interfaz.',
    },
    { id: 'floating-a', role: 'assistant', text: 'Puedes mover este chat' },
  ];
  fixtureSession.status = 'working';
  // Account polling and focus can publish the real, empty conversation during
  // these screenshots. Isolate only this renderer's synthetic state stream;
  // every other event and all native lifecycle IPC keep their real handlers.
  const fixtureTransport = await app.evaluateHandle(({ BrowserWindow }, id) => {
    const contents = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().includes(id),
    ).webContents;
    const send = contents.send;
    contents.send = function (channel, ...args) {
      if (channel === 'desk:event' && args[0]?.type === 'state') return;
      return send.call(this, channel, ...args);
    };
    return {
      publish(state) {
        send.call(contents, 'desk:event', { type: 'state', state });
      },
      restore() {
        contents.send = send;
      },
    };
  }, first.id);
  try {
    const publish = () =>
      fixtureTransport.evaluate((transport, state) => transport.publish(state), fixture);
    await publish();
    await one.locator('.messages').getByText('Puedes mover este chat', { exact: true }).waitFor();
    fixtureSession.messages[1].text =
      'Puedes mover este chat a cualquier parte de la pantalla. La conversación y tus archivos siguen aquí, mientras trabajas en el editor.';
    fixtureSession.status = 'ready';
    await publish();
    await one
      .locator('.messages')
      .getByText(fixtureSession.messages[1].text, { exact: true })
      .waitFor();
    await one.screenshot({ path: 'artifacts/floating-chat-dark.png' });
    // Pin and transparency remain accessible from a right click on the header.
    await one.locator('.floating-chat-controls').click({ button: 'right' });
    await one.getByRole('dialog', { name: 'Opciones de ventana flotante', exact: true }).waitFor();
    await one.screenshot({ path: 'artifacts/floating-chat-options.png', animations: 'disabled' });
    await one.keyboard.press('Escape');
    await one.emulateMedia({ colorScheme: 'light' });
    await one.waitForTimeout(300);
    await one.screenshot({ path: 'artifacts/floating-chat-light.png' });
    await one.emulateMedia({ colorScheme: 'dark' });
  } finally {
    try {
      await fixtureTransport.evaluate((transport) => transport.restore());
    } finally {
      await fixtureTransport.dispose();
    }
  }

  const closedOne = one.waitForEvent('close');
  await one.getByRole('button', { name: 'Volver al editor', exact: true }).click();
  await closedOne;
  await draft.waitFor();
  assert.equal(await draft.inputValue(), 'Editado en la ventana flotante');
  await page.getByRole('button', { name: 'Quitar nota.txt', exact: true }).waitFor();
  assert.equal((await snapshot(page)).selectedSession, first.id);
  assert.equal((await snapshot(page)).floatingChats.length, 1);
  assert.equal((await snapshot(page)).sessions.find((s) => s.id === first.id).status, first.status);

  const reopened = await float(page, first.id);
  const closedReopened = reopened.waitForEvent('close');
  assert.equal(
    (await snapshot(page)).floatingChats.find((f) => f.sessionId === first.id).opacity,
    0.15,
  );
  await reopened.getByRole('button', { name: 'Cerrar ventana flotante', exact: true }).click();
  await closedReopened;
  await visibility(true, 1);
  const afterClose = await snapshot(page);
  assert.ok(afterClose.sessions.some((s) => s.id === first.id));
  assert.equal(afterClose.sessions.find((s) => s.id === first.id).status, first.status);
  assert.equal(afterClose.floatingChats.length, 1);
  // Native OS closure also preserves the chat and its draft.
  const osWindow = await float(page, first.id);
  const closedOSWindow = osWindow.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes(id))
      .close();
  }, first.id);
  await closedOSWindow;
  await draft.waitFor();
  assert.equal(await draft.inputValue(), 'Editado en la ventana flotante');
  // A floating chat survives closing the main editor and can recreate it on return.
  const closedEditor = page.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.webContents.getURL().includes('#chat='))
      .close();
  });
  await closedEditor;
  assert.equal(two.isClosed(), false);
  await two
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Sigo aquí con el editor cerrado');
  const restoredEditor = app.waitForEvent('window');
  const closedTwo = two.waitForEvent('close');
  await two.getByRole('button', { name: 'Volver al editor', exact: true }).click();
  page = await restoredEditor;
  page.on('pageerror', (e) => errors.push(e.message));
  await closedTwo;
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Sigo aquí con el editor cerrado',
  );
  const removedWindow = await float(page, second.id);
  const closedRemoved = removedWindow.waitForEvent('close');
  await call(page, { type: 'deleteSession', sessionId: second.id });
  await closedRemoved;
  await page.waitForFunction(
    async () => !(await window.desk.invoke({ type: 'snapshot' })).floatingChats.length,
  );
  const savedPreferences = JSON.parse(
    await fs.readFile(path.join(root, 'data', 'floating-chats.json'), 'utf8'),
  );
  assert.equal(savedPreferences[second.id], undefined);
  assert.ok(savedPreferences[first.id]);
  assert.equal(two.isClosed(), true);
  assert.equal(reopened.isClosed(), true);
  assert.deepEqual(errors, []);
  console.log(
    'Floating chats: grouped focus visibility, external-window focus, X close, multiwindow, draft/attachment handoff, opacity, docking, OS close and deletion OK.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
