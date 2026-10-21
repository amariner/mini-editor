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
  let page = await app.firstWindow();
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
  await page.getByRole('button', { name: `Sacar chat ${first.title}`, exact: true }).click();
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
  const two = await float(page, second.id);
  assert.equal(app.windows().length, 3);
  await two
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Segundo chat independiente');
  assert.equal(await text.inputValue(), 'Editado en la ventana flotante');
  assert.equal(await one.locator('.floating-chat-title strong').innerText(), first.title);
  assert.equal((await snapshot(page)).selectedSession, second.id);

  // Only native app windows can invoke IPC; a floating window cannot control a sibling.
  await assert.rejects(
    call(one, { type: 'floatingChat', sessionId: second.id, operation: 'close' }),
    /otra conversación/,
  );
  // Options open from a right click on the header; the header shows only "Volver al editor".
  await one.locator('.floating-chat-header').click({ button: 'right' });
  await one.getByLabel('Transparencia en reposo').fill('55');
  await one.waitForFunction(() =>
    getComputedStyle(document.querySelector('.app'))
      .getPropertyValue('--floating-opacity')
      .trim()
      .startsWith('55'),
  );
  // The tint eases in; read it once the transition has settled.
  await one.waitForTimeout(400);
  const alpha = await one.evaluate(() => ({
    root: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.querySelector('.composer textarea')).opacity,
    background: getComputedStyle(document.querySelector('.app')).backgroundColor,
    input: getComputedStyle(document.querySelector('.desk-input')).backgroundColor,
    layers: ['main', '.work-area', '.workspace', '.conversation', '.messages', '.composer'].map(
      (selector) => [selector, getComputedStyle(document.querySelector(selector)).backgroundColor],
    ),
  }));
  assert.equal(alpha.root, 'rgba(0, 0, 0, 0)');
  assert.equal(alpha.body, 'rgba(0, 0, 0, 0)');
  assert.equal(alpha.text, '1');
  // The options panel is open, so the window previews the resting tint instead of turning solid.
  // The options panel is open, so the window previews the resting tint instead of turning solid.
  assert.match(alpha.background, /0\.55/);
  // The writing area keeps its own near-solid backing.
  assert.match(alpha.input, /0\.86/);
  // The writing area keeps its own near-solid backing.
  assert.match(alpha.input, /0\.86/);
  assert.ok(
    alpha.layers.every(([, color]) => color === 'rgba(0, 0, 0, 0)'),
    JSON.stringify(alpha.layers),
  );
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
    return {
      right: composer.right,
      bottom: composer.bottom,
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.ok(layout.right <= layout.width && layout.bottom <= layout.height, JSON.stringify(layout));
  assert.equal(layout.overflow, false);
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
  const publish = async () =>
    app.evaluate(
      ({ BrowserWindow }, { id, state }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().includes(id))
          .webContents.send('desk:event', { type: 'state', state });
      },
      { id: first.id, state: fixture },
    );
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
  // Options open from a right click on the header; the header shows only "Volver al editor".
  await one.locator('.floating-chat-header').click({ button: 'right' });
  await one.screenshot({ path: 'artifacts/floating-chat-options.png' });
  await one.keyboard.press('Escape');
  await one.emulateMedia({ colorScheme: 'light' });
  await one.screenshot({ path: 'artifacts/floating-chat-light.png' });
  await one.emulateMedia({ colorScheme: 'dark' });

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
    0.55,
  );
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes(id))
      .close();
  }, first.id);
  await closedReopened;
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
  assert.equal(two.isClosed(), true);
  assert.equal(reopened.isClosed(), true);
  assert.deepEqual(errors, []);
  console.log(
    'Floating chats: native multiwindow, isolation, draft/attachment handoff, opacity, pin, bounds, docking, OS close and deletion OK.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
