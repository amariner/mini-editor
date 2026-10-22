// Renderer resilience with controlled IPC timing; no accounts, network or providers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const output = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'desk-state-sync-'))
  : undefined;
let server, browser;
try {
  if (output) await build({ build: { outDir: output, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: output ?? 'dist' },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((protocol) => {
    const listeners = new Set();
    const state = {
      profiles: [{ id: 'claude:fixture', kind: 'claude', name: 'Cuenta de prueba' }],
      defaultProfile: 'claude:fixture',
      accounts: {},
      tools: {},
      dataDir: '/tmp/fixture',
      projects: [{ id: 'p', name: 'Proyecto', path: '/tmp/fixture' }],
      selectedProject: 'p',
      selectedSession: 's',
      sessions: [
        {
          id: 's',
          projectId: 'p',
          profile: 'claude:fixture',
          title: 'Chat original',
          mode: 'chat',
          status: 'ready',
          approvals: [],
          messages: [],
          info: { models: [{ value: 'fixture', displayName: 'Fixture' }], commands: [] },
        },
      ],
      browsers: [],
      devServers: [],
      coordination: [],
      runtime: { protocol, instanceId: 'state-sync-fixture' },
    };
    let reads = 0;
    const publish = () =>
      listeners.forEach((listener) => listener({ type: 'state', state: structuredClone(state) }));
    window.fixture = {
      state,
      publish,
      emit: (event) => listeners.forEach((listener) => listener(event)),
      actions: [],
      failNextSnapshot: false,
      releaseSnapshot: null,
      releaseClose: null,
    };
    window.desk = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async invoke(action) {
        window.fixture.actions.push(action);
        if (action.type === 'snapshot') {
          reads++;
          if (reads === 1) throw new Error('Fallo inicial de prueba');
          if (reads === 2) {
            const stale = structuredClone(state);
            return new Promise((resolve) => {
              window.fixture.releaseSnapshot = () => resolve(stale);
            });
          }
          if (window.fixture.failNextSnapshot) {
            window.fixture.failNextSnapshot = false;
            throw new Error('Fallo de actualización de prueba');
          }
          return structuredClone(state);
        }
        if (action.type === 'diff') return { repository: false };
        if (action.type === 'listFiles') return [];
        if (action.type === 'send') {
          state.sessions[0].messages.push({
            id: 'sent',
            role: 'user',
            text: action.text,
            at: Date.now(),
          });
          publish();
          window.fixture.failNextSnapshot = true;
          return true;
        }
        if (action.type === 'browserTab' && action.input.action === 'close') {
          await new Promise((resolve) => {
            window.fixture.releaseClose = resolve;
          });
          state.browsers = state.browsers.filter((tab) => tab.id !== action.tabId);
          publish();
        }
        return true;
      },
    };
  }, protocol);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await page.waitForFunction(() => !!window.fixture.releaseSnapshot);
  await page.evaluate(() => {
    window.fixture.state.sessions[0].title = 'Chat actualizado';
    window.fixture.publish();
  });
  await page.locator('.project-chat').filter({ hasText: 'Chat actualizado' }).waitFor();
  await page.evaluate(() => window.fixture.releaseSnapshot());
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.project-chat').filter({ hasText: 'Chat original' }).count(), 0);

  const composer = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await composer.fill('Enviar una sola vez');
  await composer.press('Enter');
  await page.getByRole('alert').filter({ hasText: 'La acción se completó' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
  assert.equal(
    await page.evaluate(() => window.fixture.actions.filter((a) => a.type === 'send').length),
    1,
  );
  assert.equal(
    await page.getByText('No se pudo enviar. Tu borrador se conserva.', { exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Cerrar error', exact: true }).click();

  const usageReads = await page.evaluate(
    () => window.fixture.actions.filter((a) => a.type === 'refreshUsage').length,
  );
  for (const status of ['working', 'waiting', 'ready']) {
    await page.evaluate(async (status) => {
      window.fixture.state.sessions[0].status = status;
      window.fixture.publish();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, status);
  }
  assert.equal(
    await page.evaluate(
      () => window.fixture.actions.filter((a) => a.type === 'refreshUsage').length,
    ),
    usageReads,
    'Agent activity transitions must not restart account quota polling',
  );

  // A slow tab close must not steal a selection made while its IPC is pending.
  await page.evaluate(() => {
    window.fixture.state.browsers = ['a', 'b', 'c'].map((id) => ({
      id,
      projectId: 'p',
      sessionId: 's',
      url: `https://${id}.example.test/`,
      title: id,
      zoom: 1,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    }));
    window.fixture.publish();
  });
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar pestaña a.example.test', exact: true }).click();
  await page.waitForFunction(() => !!window.fixture.releaseClose);
  await page.getByRole('tab', { name: 'c.example.test', exact: true }).click();
  await page.evaluate(() => window.fixture.releaseClose());
  await page
    .getByRole('tab', { name: 'a.example.test', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(
    await page
      .getByRole('tab', { name: 'c.example.test', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );

  // The native menu should replace a dialog, never stack Search and Settings.
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('dialog', { name: 'Ajustes', exact: true }).waitFor();
  await page.evaluate(() => {
    window.fixture.state.projects = Array.from({ length: 1000 }, (_, i) => ({
      id: `p${i}`,
      name: `Proyecto ${i}`,
      path: `/tmp/${i}`,
    }));
    window.fixture.publish();
    window.fixture.emit({ type: 'shortcut', action: 'search' });
  });
  await page.getByRole('dialog', { name: 'Buscar proyectos y sesiones', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Ajustes', exact: true }).count(), 0);
  assert.equal(await page.getByRole('option').count(), 60);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: startup retry, late snapshot ordering, confirmed send despite refresh failure, concurrent browser navigation and bounded search.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server ? server.httpServer.close((error) => (error ? reject(error) : resolve())) : resolve(),
  );
  if (output) await fs.rm(output, { recursive: true, force: true });
}
