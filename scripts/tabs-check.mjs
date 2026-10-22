import { createTestAccounts } from './test-accounts.mjs';
// Isolated Electron chat navigation/lifecycle check. No prompts or existing credentials are used.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-tabs-')));
const folder = path.join(root, 'Proyecto temporal');
await fs.mkdir(folder);
// Exercise the real RPC process lifecycle without relying on an installed Codex release.
const codex = path.join(root, 'codex-fixture');
await fs.writeFile(
  codex,
  `#!${process.execPath}
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } };
  if (message.method === 'model/list') result = { data: [{ model: 'fixture-model', displayName: 'Fixture', isDefault: true }], nextCursor: null };
  if (message.method === 'thread/start' || message.method === 'thread/resume') result = { thread: { id: 'fixture-thread', turns: [] } };
  console.log(JSON.stringify({ id: message.id, result }));
});
`,
  { mode: 0o700 },
);
await fs.mkdir(path.join(root, 'data'));
await fs.writeFile(
  path.join(root, 'data', 'state.json'),
  JSON.stringify({ profiles: [], projects: [], sessions: [], tools: { codex } }),
);
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snap = () => call({ type: 'snapshot' });
const settle = async () => {
  const selected = (await snap()).selectedSession;
  await page.waitForFunction((id) => {
    const selectedRow = [...document.querySelectorAll('.project-chat-row')].find(
      (row) => row.dataset.sessionId === id,
    );
    return (
      selectedRow?.querySelector('.project-chat[aria-current="true"]') &&
      !document.querySelector('.project-new-chat')?.disabled
    );
  }, selected);
};
const chatButton = (id) => page.locator(`.project-chat-row[data-session-id="${id}"] .project-chat`);
const expandSidebar = async () => {
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.keyboard.press('Meta+b');
    await page.locator('.sidebar:not(.collapsed)').waitFor();
  }
};
const choose = async (title) => {
  await expandSidebar();
  const target = (await snap()).sessions.find((session) => session.title === title);
  assert.ok(target, `Chat exists: ${title}`);
  await chatButton(target.id).click();
  await page.waitForFunction(
    async (id) => (await window.desk.invoke({ type: 'snapshot' })).selectedSession === id,
    target.id,
  );
  await settle();
};
const newChat = async () => {
  const previous = (await snap()).selectedSession;
  await page.keyboard.press('Meta+n');
  await page.waitForFunction(
    async (id) => (await window.desk.invoke({ type: 'snapshot' })).selectedSession !== id,
    previous,
  );
  await settle();
};
try {
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
  await page.waitForFunction(() => !!window.desk);
  await createTestAccounts(page);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await page.getByRole('button', { name: 'Añadir proyecto', exact: true }).first().click();
  await settle();
  assert.equal(await page.locator('.session-tabs-bar').count(), 0);
  const first = (await snap()).selectedSession;
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Borrador conservado');
  await newChat();
  await choose('Sesión 1');
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Borrador conservado',
  );
  await page.getByRole('combobox', { name: 'Cuenta del chat' }).selectOption('codex');
  await page.waitForFunction(
    () => document.querySelector('.account-switcher select')?.value === 'codex',
  );
  await settle();
  await call({ type: 'start', sessionId: first });
  await page.waitForFunction(
    async (id) =>
      (await window.desk.invoke({ type: 'snapshot' })).sessions.find((s) => s.id === id)?.status ===
      'ready',
    first,
  );
  await call({ type: 'setDefaultAccount', profile: 'codex' });
  for (let i = 0; i < 6; i++) await newChat();
  assert.equal((await snap()).sessions.filter((s) => s.profile === 'codex').length, 7);
  assert.equal(
    await page.locator('.project-chat').count(),
    8,
    'All project chats remain reachable without tab eviction',
  );
  await choose('Sesión 1');
  assert.equal((await snap()).sessions.find((s) => s.id === first).status, 'ready');
  await page.getByRole('button', { name: 'Eliminar chat Sesión 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal((await snap()).sessions.find((s) => s.id === first).status, 'ready');
  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-2',
  });
  await settle();
  await choose('Sesión 1');
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({
    path: 'artifacts/28-navegacion-lateral-chats.png',
    animations: 'disabled',
  });
  assert.equal(await page.locator('.brand,.brand-mark').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Ajustes', exact: true }).innerText(), '');
  assert.equal(
    await page.getByRole('button', { name: 'Plegar proyectos', exact: true }).count(),
    0,
  );
  await page.keyboard.press('Meta+b');
  await page.locator('.sidebar.collapsed').waitFor();
  await page.setViewportSize({ width: 900, height: 620 });
  const foldedSettings = await page
    .getByRole('button', { name: 'Ajustes', exact: true })
    .boundingBox();
  const foldedRail = await page.locator('.sidebar.collapsed').boundingBox();
  assert.ok(
    foldedSettings.x >= foldedRail.x &&
      foldedSettings.x + foldedSettings.width <= foldedRail.x + foldedRail.width &&
      foldedSettings.height >= 28,
    `Settings stays reachable within the compact rail: ${JSON.stringify({ foldedSettings, foldedRail })}`,
  );
  assert.ok(
    await page
      .locator('.work-area')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  );
  await page.screenshot({ path: 'artifacts/29-chats-compactos.png', animations: 'disabled' });
  await page.keyboard.press('Meta+k');
  await page.getByPlaceholder('Buscar proyecto o sesión…').fill('Sesión 1');
  await page
    .locator('.palette-results button')
    .filter({ has: page.getByText('Sesión 1', { exact: true }) })
    .filter({ hasText: 'Codex' })
    .filter({ hasText: 'Proyecto temporal' })
    .click();
  await settle();
  assert.equal((await snap()).selectedSession, first);
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Borrador conservado',
  );
  // The sidebar owns navigation and renaming; the composer only exposes a compact Git control.
  await expandSidebar();
  assert.equal(await page.locator('.chat-switcher').count(), 0);
  assert.equal(await page.locator('.desk-input .git-summary').count(), 0);
  const gitTrigger = page.getByRole('button', { name: 'Gestionar ramas y Git', exact: true });
  assert.equal(await page.locator('.composer-footer .git-dock-trigger').count(), 1);
  await gitTrigger.focus();
  await page.keyboard.press('ArrowUp');
  await page.getByRole('dialog', { name: 'Flujo de Git', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('dialog', { name: 'Flujo de Git', exact: true })
    .waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.matches('.git-dock-trigger'));

  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-2',
  });
  await settle();
  await chatButton(first).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    async (id) => (await window.desk.invoke({ type: 'snapshot' })).selectedSession === id,
    first,
  );
  await settle();
  await page.waitForFunction(
    (id) => document.activeElement?.closest('.project-chat-row')?.dataset.sessionId === id,
    first,
  );
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: 'Nombre del chat', exact: true }).fill('Chat renombrado');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    async (id) =>
      (await window.desk.invoke({ type: 'snapshot' })).sessions.find((chat) => chat.id === id)
        ?.title === 'Chat renombrado',
    first,
  );
  await page.waitForFunction(
    (id) => document.activeElement?.closest('.project-chat-row')?.dataset.sessionId === id,
    first,
  );
  await chatButton(first).click({ button: 'right' });
  await page
    .getByRole('textbox', { name: 'Nombre del chat', exact: true })
    .fill('Cambio cancelado');
  await page.keyboard.press('Escape');
  assert.equal((await snap()).sessions.find((chat) => chat.id === first).title, 'Chat renombrado');
  await page.waitForFunction(
    (id) => document.activeElement?.closest('.project-chat-row')?.dataset.sessionId === id,
    first,
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Mensaje', exact: true }).inputValue(),
    'Borrador conservado',
  );
  // Selection must not steal focus from a subsequent keyboard or pointer interaction.
  for (const [title, interaction] of [
    ['Sesión 2', 'keydown'],
    ['Chat renombrado', 'pointerdown'],
  ]) {
    const target = (await snap()).sessions.find((session) => session.title === title).id;
    await page.evaluate(
      ({ target, interaction }) => {
        [...document.querySelectorAll('.project-chat-row')]
          .find((row) => row.dataset.sessionId === target)
          .querySelector('.project-chat')
          .click();
        window.dispatchEvent(
          interaction === 'keydown'
            ? new KeyboardEvent('keydown', { key: 'Tab' })
            : new PointerEvent('pointerdown'),
        );
        document.querySelector('button[aria-label="Ajustes"]').focus();
      },
      { target, interaction },
    );
    await page.waitForFunction(
      async (id) => (await window.desk.invoke({ type: 'snapshot' })).selectedSession === id,
      target,
    );
    await settle();
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      'Ajustes',
      'New input keeps focus after sidebar chat selection',
    );
  }
  // A real Claude PTY remains alive while another chat is selected; removal confirms its shutdown.
  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-1',
    mode: 'terminal',
  });
  await settle();
  const terminalId = (await snap()).selectedSession;
  const terminalTitle = (await snap()).sessions.find((s) => s.id === terminalId).title;
  await call({ type: 'setIsolation', sessionId: terminalId, isolation: 'shared' });
  await call({ type: 'start', sessionId: terminalId });
  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-2',
  });
  await settle();
  assert.equal((await snap()).sessions.find((s) => s.id === terminalId).status, 'terminal');
  await choose(terminalTitle);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await settle();
  await page.locator('.xterm').waitFor();
  assert.equal(await page.locator('.xterm').count(), 1);
  await expandSidebar();
  await page.getByRole('button', { name: `Eliminar chat ${terminalTitle}`, exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Detener y eliminar', exact: true }).click();
  await page.getByRole('dialog', { name: 'Eliminar conversación' }).waitFor({ state: 'hidden' });
  await page.waitForFunction(
    async (id) =>
      !(await window.desk.invoke({ type: 'snapshot' })).sessions.some((s) => s.id === id),
    terminalId,
  );
  assert.ok(
    (await snap()).sessions.some((s) => s.id === first),
    'Deleting one chat preserves the other conversations',
  );
  assert.deepEqual(errors, []);
  console.log(
    'OK: sidebar chat navigation/rename, compact Git control, all chats reachable, live processes preserved across navigation, drafts, mixed accounts, deletion cancellation/confirmed stop, CmdK recovery, compact layout and keyboard focus.',
  );
} finally {
  if (app) {
    // Stop only fixture-owned sessions so the isolated app can quit without a live-process prompt.
    const state = await snap().catch(() => undefined);
    for (const session of state?.sessions ?? [])
      await call({ type: 'stop', sessionId: session.id }).catch(() => {});
    const closeTimeout = setTimeout(() => app.process().kill('SIGTERM'), 10000);
    try {
      await app.close();
    } finally {
      clearTimeout(closeTimeout);
    }
  }
  await fs.rm(root, { recursive: true, force: true });
}
