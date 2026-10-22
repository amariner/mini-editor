// Renderer fixture test: no real accounts, agents, or model calls.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const protocol = Number(
  (await fs.readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8')).match(
    /IPC_VERSION = (\d+)/,
  )[1],
);
const testBuild = process.env.SOURCE_BUILD
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-chat-'))
  : undefined;
if (testBuild) await build({ build: { outDir: testBuild, emptyOutDir: true }, logLevel: 'silent' });
const server = await preview({
  build: { outDir: testBuild ?? 'dist' },
  preview: { host: '127.0.0.1', port: 0 },
  logLevel: 'silent',
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 760 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((protocol) => {
    const session = {
      id: 's',
      projectId: 'p',
      profile: 'claude-1',
      title: '¿Qué stack utilizas?',
      status: 'working',
      mode: 'chat',
      optimization: { model: 'Sonnet 5.5', autoModel: true, level: 3, reason: 'General' },
      approvals: [],
      messages: [
        { id: 'u', role: 'user', text: '¿Qué stack utilizas?' },
        {
          id: 'a1',
          role: 'assistant',
          text: '',
          blocks: [
            { type: 'thinking', text: 'Revisar los archivos del proyecto.', final: true },
            { type: 'text', text: 'Voy a revisar el proyecto para responderte.' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: 'package.json' },
              done: true,
              result: '{}',
            },
          ],
        },
        {
          id: 'a2',
          role: 'assistant',
          text: '',
          blocks: [
            {
              type: 'tool_use',
              id: 't2',
              name: 'Bash',
              input: { command: 'ls public', description: 'Revisando la estructura del proyecto' },
              done: false,
            },
          ],
        },
      ],
    };
    const state = {
      profiles: [
        {
          id: 'claude-1',
          name: 'Personal',
          kind: 'claude',
          optimization: { level: 3, autoModel: true },
        },
      ],
      accounts: {},
      projects: [{ id: 'p', name: 'Proyecto', path: '/tmp/compact-chat-fixture' }],
      sessions: [session],
      selectedSession: 's',
      selectedProject: 'p',
      tools: {},
      dataDir: '/tmp/compact-chat-fixture',
      runtime: { protocol },
      coordination: [],
    };
    const listeners = new Set();
    window.compactFixture = {
      session,
      state,
      publish() {
        for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
      },
    };
    window.desk = {
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async invoke(action) {
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'diff')
          return { branch: 'main', files: [], lines: { added: 0, removed: 0 } };
        if (action.type === 'refreshUsage') return;
        throw new Error(`Unexpected fixture action: ${action.type}`);
      },
    };
  }, protocol);
  await page.goto(server.resolvedUrls.local[0]);
  const chat = page.locator('.workspace');
  const progress = chat.getByRole('button', { name: 'Ver progreso', exact: true });
  await progress.waitFor();
  assert.equal(await chat.locator('.messages .tool').count(), 0);
  assert.equal(await chat.locator('.messages .author').count(), 0);
  const narration = chat.locator('.messages .progress-message');
  assert.equal(await narration.innerText(), 'Voy a revisar el proyecto para responderte.');
  assert.ok(await narration.isVisible());
  assert.equal(
    await progress.locator('.activity-current-text').innerText(),
    'Revisando la estructura del proyecto',
  );
  const composer = await chat.locator('.composer').boundingBox();
  const context = await chat.locator('.git-summary').boundingBox();
  const dock = await progress.boundingBox();
  assert.ok(dock.y + dock.height <= context.y);
  assert.ok(context.y - (dock.y + dock.height) < 10);
  assert.ok(context.y + context.height <= composer.y);
  assert.ok(dock.height <= 26);
  assert.equal(await chat.locator('.task-signature').innerText(), 'Personal');
  const insight = chat.locator('.footer-insight');
  const insightCard = chat.locator('.footer-insight-card');
  assert.equal(await insightCard.isVisible(), false);
  // Model, tokens and usage remain available from the quiet footer with the keyboard.
  await page.keyboard.press('Tab');
  await insight.focus();
  await insightCard.waitFor({ state: 'visible' });
  assert.equal(await insightCard.locator('.task-signature-model').innerText(), 'Sonnet 5.5');
  assert.equal(await insightCard.locator('.task-signature-tokens').innerText(), '↑— ↓—');
  assert.equal(await insightCard.locator('.usage-window-head').innerText(), 'Franja de 5 h\n—');
  assert.equal(
    await insightCard.locator('.usage-window small').innerText(),
    'Esperando datos de la suscripción.',
  );
  await progress.click();
  await insightCard.waitFor({ state: 'hidden' });
  assert.equal(await chat.locator('.activity-log .tool').count(), 2);
  assert.equal(await chat.locator('.activity-log .step-text').count(), 0);
  await chat.locator('.activity-log .tool-head').first().click();
  assert.equal(await chat.locator('.activity-log .result').innerText(), '{}');
  await progress.click();
  await page.evaluate(() => {
    const f = window.compactFixture;
    f.session.messages[2].blocks.push({ type: 'text', text: 'He encontrado' });
    f.publish();
  });
  await narration.getByText('He encontrado', { exact: true }).waitFor();
  await page.evaluate(() => {
    const f = window.compactFixture;
    f.session.messages[2].blocks[1].text += ' la configuración y sigo comprobando los archivos.';
    f.publish();
  });
  await narration
    .getByText('He encontrado la configuración y sigo comprobando los archivos.', { exact: true })
    .waitFor();
  assert.equal(
    await progress.locator('.activity-current-text').innerText(),
    'Redactando respuesta…',
  );
  await page.evaluate(() => {
    const f = window.compactFixture;
    f.session.subagents = [
      { id: 'review', description: 'Revisar los componentes', summary: 'Revisar los componentes' },
    ];
    f.publish();
  });
  const execution = chat.locator('.execution-panel');
  await execution.waitFor();
  assert.equal(await execution.getAttribute('open'), null);
  assert.match(
    await execution.locator('summary').innerText(),
    /1 agente.*Revisar los componentes/s,
  );
  await execution.locator('summary').click();
  assert.equal(await execution.locator('li').innerText(), 'Revisar los componentes');
  await execution.locator('summary').click();
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/chat-compacto-progreso.png' });
  await page.evaluate(() => {
    const f = window.compactFixture;
    f.session.messages[2].blocks[0].done = true;
    f.session.messages.push({
      id: 'final',
      role: 'assistant',
      text: '',
      blocks: [
        {
          type: 'text',
          text: 'El proyecto usa **JavaScript puro**.\n\n- Servidor: Node.js.\n- Interfaz: HTML, CSS y JavaScript.\n- Audio: Web Audio API.',
        },
      ],
    });
    f.session.status = 'ready';
    f.session.stats = {
      cost: 0,
      turns: 1,
      inputTokens: 1234,
      outputTokens: 340,
      durationMs: 1000,
      tokensReported: true,
    };
    f.publish();
  });
  await chat.getByText('El proyecto usa', { exact: false }).waitFor();
  await page.keyboard.press('Tab');
  await insight.focus();
  await insightCard.waitFor({ state: 'visible' });
  assert.equal(await chat.locator('.task-signature-tokens').innerText(), '↑1,2k ↓340');
  assert.match(
    await insightCard.locator('.insight-row:has(.task-signature-tokens)').getAttribute('title'),
    /Entrada: 1234|Entrada: 1.234/,
  );
  const signature = await chat.locator('.task-signature').boundingBox();
  const finishedComposer = await chat.locator('.composer').boundingBox();
  assert.ok(signature.y >= finishedComposer.y + finishedComposer.height);
  await chat.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Otra tarea');
  await insight.focus();
  await insightCard.waitFor({ state: 'visible' });
  assert.equal(await chat.locator('.task-signature-model').innerText(), 'Auto');
  await chat.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('');
  assert.equal(await progress.count(), 0);
  assert.equal(await chat.locator('.response-work').count(), 1);
  assert.equal(await chat.locator('.response-work').getAttribute('open'), null);
  assert.equal(
    await chat
      .getByText('Voy a revisar el proyecto para responderte.', { exact: true })
      .isVisible(),
    false,
  );
  assert.equal(
    await chat
      .getByText('He encontrado la configuración y sigo comprobando los archivos.', { exact: true })
      .isVisible(),
    false,
  );
  await chat.getByText('Leyó 1 archivo y ejecutó 1 comando', { exact: true }).click();
  assert.equal(await chat.locator('.response-work .tool').count(), 2);
  assert.ok(
    await chat
      .getByText('Voy a revisar el proyecto para responderte.', { exact: true })
      .isVisible(),
  );
  assert.ok(
    await chat
      .getByText('He encontrado la configuración y sigo comprobando los archivos.', { exact: true })
      .isVisible(),
  );
  assert.equal(
    await chat.getByText('Voy a revisar el proyecto para responderte.', { exact: true }).count(),
    1,
  );
  await chat.getByText('Leyó 1 archivo y ejecutó 1 comando', { exact: true }).click();
  await page.screenshot({ path: 'artifacts/chat-compacto-respuesta.png' });
  // Existing final response must remain visible while the next process starts.
  await page.evaluate(() => {
    const f = window.compactFixture;
    f.session.status = 'starting';
    f.publish();
  });
  await chat.getByText('Abriendo agente…', { exact: true }).waitFor();
  assert.ok(await chat.getByText('El proyecto usa', { exact: false }).isVisible());
  await page.evaluate(() => {
    const f = window.compactFixture;
    f.session.messages.push({ id: 'u2', role: 'user', text: 'Crea un archivo' });
    f.session.status = 'waiting';
    f.session.approvals = [
      {
        id: 'approval',
        method: 'claude/permission',
        params: {},
        tool: 'Write',
        input: { file_path: 'notes.md', content: 'Prueba' },
      },
    ];
    f.publish();
  });
  await chat.getByText('Esperando tu respuesta', { exact: true }).waitFor();
  assert.ok(await chat.locator('.approval').isVisible());
  await page.setViewportSize({ width: 900, height: 650 });
  assert.ok((await progress.boundingBox()).height <= 26);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: mensajes en vivo y persistentes, herramientas plegadas, resultado, arranque y permisos visibles.',
  );
} finally {
  await browser?.close();
  await server.close();
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
