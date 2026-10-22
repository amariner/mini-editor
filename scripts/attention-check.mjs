// Cross-provider review queue: isolated fixture, no accounts, agents or remote requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const protocol = Number(
  (await fs.readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8')).match(
    /IPC_VERSION = (\d+)/,
  )[1],
);
const testBuild = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-attention-'))
  : undefined;
if (testBuild) await build({ build: { outDir: testBuild, emptyOutDir: true }, logLevel: 'silent' });
const server = await preview({
  build: { outDir: testBuild ?? 'dist' },
  preview: { host: '127.0.0.1', port: 0 },
  logLevel: 'silent',
});
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('Attention fixture page error:', error.message);
  });
  await page.addInitScript((protocol) => {
    const titles = [
      'Conversación actual',
      'Verificar el formulario',
      'Elegir el entorno',
      'Revisar conexión',
    ];
    const state = {
      projects: [
        { id: 'p', name: 'Studio', path: '/tmp/attention-studio' },
        { id: 'p2', name: 'Web', path: '/tmp/attention-web' },
      ],
      profiles: [
        { id: 'claude-1', kind: 'claude', name: 'Personal' },
        { id: 'codex', kind: 'codex', name: 'Codex' },
      ],
      defaultProfile: 'claude-1',
      accounts: {},
      sessions: titles.map((title, i) => ({
        id: `s${i}`,
        title,
        projectId: i < 2 ? 'p' : 'p2',
        profile: i === 2 ? 'codex' : 'claude-1',
        mode: 'chat',
        status: i === 1 ? 'working' : 'ready',
        approvals: [],
        config: { model: 'sonnet' },
        info: {
          model: 'sonnet',
          models: [{ value: 'sonnet', displayName: 'Sonnet' }],
          commands: [],
          tools: [],
          mcpServers: [],
          skills: [],
          plugins: [],
          agents: [],
          outputStyles: [],
        },
        messages: [
          { id: `u${i}`, role: 'user', text: 'Revisa los cambios.' },
          {
            id: `a${i}`,
            role: 'assistant',
            text: i === 1 ? 'Estoy verificando…' : 'Respuesta anterior.',
          },
        ],
      })),
      selectedProject: 'p',
      selectedSession: 's0',
      tools: {},
      coordination: [],
      runtime: { protocol },
      dataDir: '/tmp/attention-fixture',
    };
    const listeners = new Set();
    const publish = () =>
      listeners.forEach((fn) => fn({ type: 'state', state: structuredClone(state) }));
    window.fixture = { state, actions: [], publish };
    window.desk = {
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async invoke(action) {
        window.fixture.actions.push(action);
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'select') {
          state.selectedProject = action.projectId;
          state.selectedSession = action.sessionId;
          publish();
          return true;
        }
        if (
          ['refreshUsage', 'accountRefresh', 'refreshModels', 'browserPresent'].includes(
            action.type,
          )
        )
          return true;
        if (action.type === 'diff')
          return {
            repository: true,
            branch: 'main',
            branches: ['main'],
            commits: [],
            files: [],
            lines: { added: 0, removed: 0 },
            counts: { conflicts: 0 },
          };
        throw new Error(`Unexpected fixture action: ${action.type}`);
      },
    };
  }, protocol);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).waitFor();
  assert.equal(
    await page.locator('.attention-trigger').count(),
    0,
    'startup history is already read',
  );
  await page.keyboard.press('Meta+Shift+a');
  await page.getByRole('dialog', { name: 'Centro de atención', exact: true }).waitFor();
  assert.match(await page.locator('.attention-empty').innerText(), /No hay nada pendiente/);
  await page.keyboard.press('Meta+Shift+a');
  await page
    .getByRole('dialog', { name: 'Centro de atención', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.attention-trigger').count(), 0);
  await page.evaluate(() => {
    const { state, publish } = window.fixture;
    // A background stream completes without creating a new message.
    state.sessions[1].status = 'ready';
    state.sessions[1].messages[1].text = 'Formulario verificado: los tres casos pasan.';
    state.sessions[2].status = 'waiting';
    state.sessions[2].approvals = [
      {
        id: 'question',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [{ id: 'env', question: '¿En qué entorno seguimos?', options: [] }],
        },
      },
    ];
    state.sessions[3].status = 'error';
    state.sessions[3].error = 'No se pudo conectar con el proveedor.';
    publish();
  });
  await page.locator('.attention-trigger').click();
  const dialog = page.getByRole('dialog', { name: 'Centro de atención', exact: true });
  await dialog.waitFor();
  const rows = dialog.locator('.attention-item');
  assert.equal(await rows.count(), 3);
  assert.deepEqual(await rows.locator('strong').allTextContents(), [
    'Elegir el entorno',
    'Revisar conexión',
    'Verificar el formulario',
  ]);
  assert.match(await dialog.innerText(), /¿En qué entorno seguimos\?/);
  assert.match(await dialog.innerText(), /Formulario verificado: los tres casos pasan\./);
  assert.match(await dialog.innerText(), /Web · Codex/);
  await rows.first().focus();
  await page.keyboard.press('End');
  assert.equal(await rows.last().evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Home');
  assert.equal(await rows.first().evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
  await fs.mkdir('artifacts/attention', { recursive: true });
  await page.screenshot({ path: 'artifacts/attention/light.png', animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'artifacts/attention/dark.png', animations: 'disabled' });
  await page.setViewportSize({ width: 500, height: 760 });
  assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: 'artifacts/attention/narrow.png', animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await dialog.evaluate((el) => getComputedStyle(el).animationDuration), '0s');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('.attention-trigger').evaluate((el) => el === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.attention-trigger').click();
  await rows.first().click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), 's2');
  assert.equal(await page.evaluate(() => window.fixture.state.selectedProject), 'p2');
  assert.equal(
    await page.evaluate(() =>
      window.fixture.actions.some((action) =>
        ['approve', 'send', 'interrupt'].includes(action.type),
      ),
    ),
    false,
  );
  await page.evaluate(() => {
    const { state, publish } = window.fixture;
    state.sessions[2].status = 'ready';
    state.sessions[2].approvals = [];
    state.sessions[3].status = 'ready';
    state.sessions[3].error = undefined;
    publish();
  });
  await page.locator('.attention-trigger').click();
  assert.equal(await rows.count(), 1);
  await rows.first().click();
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.attention-trigger').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.fixture.state.selectedSession), 's1');
  // A selected chat can finish while the app is unfocused. Reading it once must
  // consume that transition: later focus/visibility events cannot resurrect it.
  await page.evaluate(() => {
    window.fixture.focused = false;
    document.hasFocus = () => window.fixture.focused;
    window.fixture.state.sessions[1].status = 'working';
    window.fixture.publish();
  });
  await page.evaluate(() => {
    window.fixture.state.sessions[1].status = 'ready';
    window.fixture.state.sessions[1].messages[1].text = 'Segunda verificación terminada.';
    window.fixture.publish();
  });
  await page.locator('.attention-trigger').waitFor();
  await page.evaluate(() => {
    window.fixture.focused = true;
    window.dispatchEvent(new Event('focus'));
  });
  await page.locator('.attention-trigger').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    window.fixture.focused = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await page.locator('.attention-trigger').count(),
    0,
    'read completion stays consumed after visibility change',
  );
  await page.evaluate(() => {
    window.fixture.focused = true;
    window.dispatchEvent(new Event('focus'));
    delete document.hasFocus;
  });
  assert.equal(await page.locator('.attention-trigger').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: atención entre agentes/proyectos, prioridad, histórico leído, final en mismo mensaje, teclado, foco, navegación, temas, ancho reducido y movimiento reducido; sin acciones del agente automáticas.',
  );
} finally {
  await browser?.close();
  await server.close();
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
