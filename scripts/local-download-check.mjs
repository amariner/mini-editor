// Renderer integration: exercise the real action wrapper with a controlled IPC bridge.
// No downloads, accounts, credentials or persistent user data are touched.
import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const server = process.env.SOURCE_DEV
  ? await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' })
  : await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
if (process.env.SOURCE_DEV) await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
    colorScheme: 'dark',
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ protocol }) => {
      const state = {
        profiles: [{ id: 'local-1', name: 'Locales', kind: 'local' }],
        accounts: { 'local-1': { status: 'signedOut' } },
        projects: [{ id: 'p', name: 'Proyecto', path: '/tmp/local-download-fixture' }],
        sessions: [
          {
            id: 's',
            projectId: 'p',
            profile: 'local-1',
            title: 'Modelos locales',
            status: 'ready',
            mode: 'chat',
            approvals: [],
            messages: [],
          },
        ],
        defaultProfile: 'local-1',
        selectedSession: 's',
        selectedProject: 'p',
        tools: {},
        dataDir: '/tmp/local-download-fixture',
        runtime: { protocol },
        coordination: [],
        theme: 'system',
      };
      const local = {
        engine: false,
        directory: '/tmp/models',
        context: 8192,
        tools: false,
        downloaded: 0,
        outputLimit: 2048,
      };
      let pending;
      window.fixture = {
        state,
        local,
        actions: [],
        polls: 0,
        progress() {
          Object.assign(local, {
            busy: 'Descargando motor llama.cpp',
            downloaded: 5e6,
            total: 10e6,
          });
        },
        fail() {
          local.busy = undefined;
          pending.reject(new Error('No se pudo conectar con el servidor de descarga.'));
        },
        finish() {
          local.engine = true;
          local.busy = undefined;
          pending.resolve(structuredClone(local));
        },
      };
      window.desk = {
        subscribe() {
          return () => {};
        },
        async invoke(action) {
          window.fixture.actions.push(action);
          if (action.type === 'snapshot') return structuredClone(state);
          if (action.type === 'diff') return { repository: false };
          if (action.type === 'localStatus') {
            window.fixture.polls++;
            return structuredClone(local);
          }
          if (action.type === 'providerCatalog') return [];
          if (action.type === 'localInstall') {
            local.downloaded = 0;
            local.total = undefined;
            return new Promise((resolve, reject) => {
              pending = { resolve, reject };
            });
          }
          if (action.type === 'localCancel') {
            local.busy = undefined;
            pending.reject(new DOMException('The operation was aborted', 'AbortError'));
            return true;
          }
          return true;
        },
      };
    },
    { protocol },
  );
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const card = page.getByRole('region', { name: 'Cuenta Locales', exact: true });
  await card.getByRole('button', { name: 'Opciones de Locales', exact: true }).click();
  const install = card.getByRole('button', { name: 'Descargar motor local', exact: true });
  const feedback = card.locator('.local-download-feedback');

  await install.click();
  await card
    .getByRole('button', { name: 'Preparando descarga…', exact: true })
    .waitFor({ timeout: 500 });
  assert.equal(
    await card.locator('.local-engine-button .local-download-spinner').isVisible(),
    true,
  );
  assert.equal(await card.getByRole('progressbar').getAttribute('value'), null);
  assert.equal(await card.getByRole('button', { name: 'Cancelar', exact: true }).isEnabled(), true);
  await page.evaluate(() => window.fixture.progress());
  await page.waitForFunction(
    () => document.querySelector('.local-download-feedback progress')?.value === 50,
  );
  assert.match(await feedback.innerText(), /5\.0 MB de 10\.0 MB · 50%/);
  await fs.mkdir('artifacts/local-download', { recursive: true });
  await page.screenshot({ path: 'artifacts/local-download/progress.png', animations: 'disabled' });

  // The root action wrapper must reject locally; its normal snapshot/poll must not erase the error.
  await page.evaluate(() => window.fixture.fail());
  const alert = card.getByRole('alert');
  await alert
    .getByText('No se pudo conectar con el servidor de descarga.', { exact: true })
    .waitFor();
  await install.waitFor();
  assert.equal(await install.isEnabled(), true);
  const polls = await page.evaluate(() => window.fixture.polls);
  await page.waitForFunction((previous) => window.fixture.polls > previous, polls);
  assert.equal(await alert.isVisible(), true);
  const bounds = await card.locator('.local-engine-download').boundingBox();
  const errorBounds = await alert.boundingBox();
  assert.ok(
    errorBounds.y >= bounds.y && errorBounds.y + errorBounds.height <= bounds.y + bounds.height + 1,
  );
  await page.screenshot({ path: 'artifacts/local-download/error.png', animations: 'disabled' });

  await install.click();
  assert.equal(await alert.count(), 0);
  await card.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await feedback.getByText('Descarga cancelada.', { exact: true }).waitFor();
  await install.waitFor();
  assert.equal(await install.isEnabled(), true);
  assert.equal(await alert.count(), 0);
  assert.equal(
    await page.evaluate(
      () => window.fixture.actions.filter((action) => action.type === 'localCancel').length,
    ),
    1,
  );

  await install.click();
  await page.evaluate(() => window.fixture.finish());
  await feedback.getByText('Motor instalado. Listo para usar.', { exact: true }).waitFor();
  assert.equal(await install.count(), 0);
  assert.equal(await card.getByRole('progressbar').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'Local download UI verified: immediate animation, progress, inline error survives polling, retry, cancellation and success.',
  );
} finally {
  await browser?.close();
  if (process.env.SOURCE_DEV) await server.close();
  else await server.httpServer.close();
}
