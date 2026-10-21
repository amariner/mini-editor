// Empty-state and lazy-grid regression checks; isolated renderer, no provider calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const testBuild = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-onboarding-'))
  : undefined;
let server, browser;
try {
  if (testBuild)
    await build({ build: { outDir: testBuild, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: testBuild ?? 'dist' },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((protocol) => {
    const listeners = new Set();
    const state = {
      profiles: [],
      accounts: {},
      projects: [],
      sessions: [],
      browsers: [],
      devServers: [],
      tools: {},
      coordination: [],
      runtime: { protocol, instanceId: 'onboarding-fixture' },
    };
    const publish = () => {
      for (const listener of listeners) listener({ type: 'state', state: structuredClone(state) });
    };
    window.fixture = {
      state,
      actions: [],
      browserNewFailure: false,
      update(next) {
        Object.assign(state, next);
        publish();
      },
      emit(event) {
        for (const listener of listeners) listener(event);
      },
    };
    window.desk = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async invoke(action) {
        window.fixture.actions.push(action);
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'diff') return { repository: false };
        if (action.type === 'listFiles') return [];
        if (action.type === 'select') {
          state.selectedProject = action.projectId;
          state.selectedSession = action.sessionId;
          publish();
        }
        if (action.type === 'browserNew') {
          if (window.fixture.browserNewFailure) throw new Error('Límite de pestañas alcanzado');
          const tab = {
            id: `tab-${state.browsers.length}`,
            sessionId: action.sessionId,
            projectId: action.projectId,
            url: action.url ?? '',
            title: 'Vista previa',
            zoom: 1,
            hostStatus: 'online',
            loading: false,
            canGoBack: false,
            canGoForward: false,
          };
          state.browsers.push(tab);
          publish();
          window.fixture.emit({
            type: 'browserOpened',
            sessionId: action.sessionId,
            tabId: tab.id,
          });
          return structuredClone(tab);
        }
        if (action.type === 'browserTab' && action.input.action === 'close') {
          state.browsers = state.browsers.filter((tab) => tab.id !== action.tabId);
          publish();
        }
        return true;
      },
    };
  }, protocol);
  await page.goto(server.resolvedUrls.local[0]);
  const button = (name) => page.getByRole('button', { name, exact: true });
  const update = (state) => page.evaluate((next) => window.fixture.update(next), state);
  const absent = async (name) => assert.equal(await button(name).count(), 0, `${name} is hidden`);
  const noPanels = async () => {
    await absent('Multichat');
    await absent('Navegador');
    assert.equal(await page.locator('.multichat-card').count(), 0);
    assert.equal(await page.locator('.browser-pane:visible').count(), 0);
    assert.equal(await page.getByText('0 chats', { exact: true }).count(), 0);
  };
  const centered = async () => {
    const center = await page.locator('.welcome').evaluate((welcome) => {
      const boxes = [...welcome.children]
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width && box.height);
      return {
        x:
          (Math.min(...boxes.map((box) => box.left)) + Math.max(...boxes.map((box) => box.right))) /
          2,
        y:
          (Math.min(...boxes.map((box) => box.top)) + Math.max(...boxes.map((box) => box.bottom))) /
          2,
        width: innerWidth,
        height: innerHeight,
      };
    });
    assert.ok(
      Math.abs(center.x - center.width / 2) < 3,
      'Welcome centered across the whole window',
    );
    assert.ok(Math.abs(center.y - center.height / 2) < 40, 'Welcome vertically centered');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  };
  await button('Añadir cuenta').waitFor();
  await absent('Añadir proyecto');
  await absent('Ajustes');
  await absent('Plegar proyectos');
  await noPanels();
  assert.equal(await page.locator('.sidebar:visible').count(), 0);
  await centered();
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/inicio-sin-cuentas.png' });
  await button('Añadir cuenta').click();
  await page.getByRole('dialog', { name: 'Ajustes', exact: true }).waitFor();
  await page.keyboard.press('Escape');

  const profile = { id: 'claude-1', name: 'Personal', kind: 'claude' };
  await update({ profiles: [profile], defaultProfile: profile.id });
  await button('Añadir proyecto').waitFor();
  await absent('Añadir cuenta');
  assert.ok(await button('Ajustes').isVisible());
  assert.ok(await button('Plegar proyectos').isVisible());
  assert.equal(await page.locator('.project-tools:visible').count(), 0);
  assert.equal(await page.locator('.sidebar-hint:visible').count(), 0);
  await noPanels();
  await centered();
  await button('Plegar proyectos').click();
  await centered();
  await button('Expandir proyectos').click();
  await page.screenshot({ path: 'artifacts/inicio-sin-proyectos.png' });
  await page.setViewportSize({ width: 800, height: 900 });
  await centered();
  await page.screenshot({ path: 'artifacts/inicio-estrecho.png' });
  await page.setViewportSize({ width: 1280, height: 860 });

  const project = { id: 'p', name: 'Proyecto de prueba', path: '/tmp/onboarding-project' };
  await update({ projects: [project], selectedProject: project.id });
  await page.locator('[data-project-id="p"]').waitFor();
  await noPanels();
  // A server started in the project terminal has no chat session to validate.
  const shellServer = {
    projectId: project.id,
    sessionId: `shell:${project.id}`,
    url: 'http://localhost:5173/',
    port: 5173,
  };
  await update({ devServers: [shellServer] });
  await button('Navegador').waitFor();
  await absent('Multichat');
  await button('Navegador').click();
  await page.locator('.browser-pane').waitFor();
  const shellRequest = await page.evaluate(() =>
    window.fixture.actions.filter((action) => action.type === 'browserNew').at(-1),
  );
  assert.equal(shellRequest.projectId, project.id);
  assert.equal(shellRequest.url, shellServer.url);
  assert.equal(shellRequest.sessionId, undefined, 'Project terminal is not sent as a chat ID');
  assert.equal(await page.evaluate(() => window.fixture.state.sessions.length), 0);
  await update({ browsers: [], devServers: [] });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Navegador"]'));
  await noPanels();
  const session = {
    id: 's',
    projectId: 'p',
    profile: profile.id,
    title: 'Chat restaurado',
    mode: 'chat',
    status: 'stopped',
    approvals: [],
    messages: [],
    info: { models: [{ value: 'fixture', displayName: 'Fixture' }], commands: [] },
  };
  // This stopped chat has never been selected or opened in this renderer.
  await update({ sessions: [session], selectedSession: undefined });
  await button('Multichat').waitFor();
  await absent('Navegador');
  assert.equal(await page.locator('.multichat-card').count(), 0);
  await button('Multichat').click();
  const card = page.locator('.multichat-card[data-session-id="s"]');
  await card.waitFor();
  await card.locator('textarea').fill('Borrador conservado al cambiar de vista');
  await button('Multichat').click();
  assert.equal(await page.locator('.multichat-card').count(), 0, 'Hidden grid releases card trees');
  await button('Multichat').click();
  await card.waitFor();
  assert.equal(
    await card.locator('textarea').inputValue(),
    'Borrador conservado al cambiar de vista',
  );
  await card.getByRole('button', { name: 'Opciones de Chat restaurado', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Ocultar Chat restaurado en el grid', exact: true })
    .click();
  assert.equal(await page.locator('.multichat-card').count(), 0);
  await button('Multichat').click();
  await button('Multichat').click();
  assert.equal(await page.locator('.multichat-card').count(), 0, 'Dismissed chats stay dismissed');
  await button('Ver chats ocultos').click();
  await card.waitFor();
  assert.equal(
    await card.locator('textarea').inputValue(),
    'Borrador conservado al cambiar de vista',
  );
  await button('Multichat').click();
  await update({ selectedSession: session.id });

  const onlineTab = {
    id: 'preview',
    projectId: project.id,
    sessionId: session.id,
    url: 'http://localhost:5173/',
    title: 'Vista previa',
    zoom: 1,
    hostStatus: 'online',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  await update({ browsers: [{ ...onlineTab, hostStatus: 'offline' }] });
  await absent('Navegador');
  await update({ browsers: [onlineTab] });
  await button('Navegador').waitFor();
  assert.equal(
    await page.locator('.browser-pane:visible').count(),
    0,
    'Availability does not open the panel',
  );
  await button('Navegador').click();
  await page.locator('.browser-pane').waitFor();
  await update({ browsers: [{ ...onlineTab, hostStatus: 'offline' }] });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Navegador"]'));
  assert.equal(
    await page.locator('.browser-pane:visible').count(),
    0,
    'Closed server hides the panel',
  );

  const remoteTab = { ...onlineTab, url: 'https://example.test/', hostStatus: undefined };
  await update({ browsers: [remoteTab] });
  await page.evaluate(() =>
    window.fixture.emit({ type: 'browserOpened', sessionId: 's', tabId: 'preview' }),
  );
  await page.locator('.browser-pane').waitFor();
  await update({ browsers: [], devServers: [] });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Navegador"]'));
  assert.equal(await page.locator('.browser-pane:visible').count(), 0);

  await button('Multichat').click();
  await update({ sessions: [], selectedSession: undefined });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Multichat"]'));
  await noPanels();
  // Saved offline tabs must remain manageable if a new preview hits the tab limit.
  const otherProject = { id: 'other', name: 'Otro proyecto', path: '/tmp/onboarding-other' };
  await update({
    projects: [project, otherProject],
    devServers: [shellServer],
    browsers: Array.from({ length: 60 }, (_, i) => ({
      ...onlineTab,
      id: `saved-${i}`,
      projectId: i < 30 ? project.id : otherProject.id,
      sessionId: i < 30 ? `shell:${project.id}` : `shell:${otherProject.id}`,
      url: `http://localhost:${6000 + i}/`,
      title: `Guardada ${i + 1}`,
      hostStatus: 'offline',
      suspended: true,
    })),
  });
  await page.evaluate(() => {
    window.fixture.browserNewFailure = true;
  });
  await button('Navegador').waitFor();
  await button('Navegador').click();
  await page.getByRole('alert').filter({ hasText: 'Límite de pestañas alcanzado' }).waitFor();
  await button('Cerrar error').click();
  assert.ok(
    await page.locator('.browser-pane').isVisible(),
    'Browser remains open after creation fails',
  );
  assert.equal(
    await page.locator('.browser-tab').count(),
    60,
    'Saved tabs from every project remain reachable',
  );
  await page.locator('.browser-tab-close').last().click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 59);
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.actions
          .filter((action) => action.type === 'browserTab' && action.input.action === 'close')
          .at(-1)?.tabId,
    ),
    'saved-59',
    'A tab from another project can be closed to free capacity',
  );
  await page.evaluate(() => {
    window.fixture.browserNewFailure = false;
  });
  await button('Navegador').click();
  await button('Navegador').click();
  await page.waitForFunction(() => document.querySelectorAll('.browser-tab').length === 60);
  assert.equal(
    await page.evaluate(() => window.fixture.state.browsers.at(-1)?.url),
    shellServer.url,
    'The preview can be opened after freeing a saved-tab slot',
  );
  await update({ browsers: [], devServers: [] });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Navegador"]'));
  await noPanels();
  await update({ projects: [], selectedProject: undefined });
  await page.locator('.welcome').waitFor();
  await centered();
  await update({ profiles: [] });
  await button('Añadir cuenta').waitFor();
  await absent('Ajustes');
  await noPanels();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: account-first onboarding, globally centered empty states, no empty sidebar/grid/browser, project-terminal previews without chat IDs, stopped chats in grid, hidden-card cleanup with drafts and dismissed state retained, offline-browser cleanup, last-chat removal and saved-tab management after preview creation fails.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => (server ? server.httpServer.close(resolve) : resolve()));
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
