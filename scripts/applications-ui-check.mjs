// Isolated renderer checks: mocked inventory and native chooser; no applications are installed.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-applications-ui-'));
let server;
let browser;
try {
  await build({ build: { outDir: output, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  await fs.mkdir('artifacts', { recursive: true });
  for (const width of [1200, 560]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ protocol }) => {
        const items = [
          {
            id: 'chrome',
            name: 'Google Chrome',
            path: '/Applications/Google Chrome.app',
            kind: 'app',
            scope: 'system',
            version: '155.0.8059.80',
            capabilities: ['Abrir', 'Mostrar en Finder', 'Control de navegador disponible'],
          },
          {
            id: 'editor',
            name: 'Editor personal',
            path: '/Users/demo/Applications/Editor.app',
            kind: 'app',
            scope: 'user',
            capabilities: ['Abrir', 'Mostrar en Finder'],
          },
          {
            id: 'cli',
            name: 'codex',
            path: '/Users/demo/.local/bin/codex',
            kind: 'cli',
            scope: 'user',
            capabilities: ['Línea de comandos', 'Mostrar en Finder'],
          },
        ];
        const state = {
          profiles: [{ id: 'claude-1', name: 'Personal', kind: 'claude' }],
          accounts: { 'claude-1': { status: 'signedIn' } },
          projects: [{ id: 'p', name: 'Demo', path: '/tmp/applications-fixture' }],
          sessions: [
            {
              id: 's',
              projectId: 'p',
              profile: 'claude-1',
              title: 'Aplicaciones',
              status: 'ready',
              mode: 'chat',
              approvals: [],
              messages: [],
            },
          ],
          defaultProfile: 'claude-1',
          selectedSession: 's',
          selectedProject: 'p',
          tools: {},
          dataDir: '/tmp/applications-fixture',
          runtime: { protocol },
          coordination: [],
          theme: 'system',
          applications: {
            items: [],
            supported: true,
            installDirectory: '/Users/demo/Applications',
          },
        };
        const listeners = new Set();
        window.fixture = { state, actions: [], installOutcome: 'cancel' };
        window.desk = {
          subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          async invoke(action) {
            window.fixture.actions.push(action);
            if (action.type === 'snapshot') return structuredClone(state);
            if (action.type === 'diff') return { repository: false };
            if (action.type === 'applicationRefresh')
              Object.assign(state.applications, { items, updatedAt: Date.now() });
            if (action.type === 'applicationInstall') {
              if (window.fixture.installOutcome === 'cancel') return undefined;
              if (window.fixture.installOutcome === 'error')
                throw new Error('Ya existe una aplicación con ese nombre. No se ha reemplazado.');
              return { ok: true, name: 'Example', path: '/Users/demo/Applications/Example.app' };
            }
            for (const listener of listeners)
              listener({ type: 'state', state: structuredClone(state) });
            return true;
          },
        };
      },
      { protocol },
    );
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    await page.getByRole('tab', { name: 'Aplicaciones', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Aplicaciones del equipo', exact: true });
    await panel.getByRole('button', { name: 'Abrir Google Chrome', exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Abrir Google Chrome', exact: true }).click();
    assert.ok(
      await page.evaluate(() =>
        window.fixture.actions.some(
          (action) => action.type === 'applicationOpen' && action.id === 'chrome',
        ),
      ),
    );
    await panel.getByRole('searchbox', { name: 'Buscar aplicaciones' }).fill('personal');
    assert.equal(await panel.locator('.application-row').count(), 1);
    await panel.getByRole('searchbox', { name: 'Buscar aplicaciones' }).fill('');
    await panel.getByRole('button', { name: 'Herramientas CLI', exact: true }).click();
    assert.equal(await panel.locator('.application-row').count(), 1);
    assert.equal(await panel.getByRole('button', { name: /^Abrir / }).count(), 0);
    await panel.getByRole('button', { name: 'Todas', exact: true }).click();
    const install = panel.getByRole('button', { name: 'Elegir aplicación', exact: true });
    await install.click();
    assert.equal(await panel.getByRole('alert').count(), 0);
    await page.evaluate(() => {
      window.fixture.installOutcome = 'error';
    });
    await install.click();
    await panel.getByRole('alert').filter({ hasText: 'No se ha reemplazado' }).waitFor();
    await page.evaluate(() => {
      window.fixture.installOutcome = 'success';
    });
    await install.click();
    await panel.getByRole('status').filter({ hasText: 'Example instalada' }).waitFor();
    assert.equal(
      await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
    );
    await page.screenshot({ path: `artifacts/applications-${width}.png` });
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'Applications UI: search, filters, open, install cancellation/error/success, narrow layout PASS',
  );
} finally {
  await browser?.close();
  await server?.httpServer.close();
  await fs.rm(output, { recursive: true, force: true });
}
