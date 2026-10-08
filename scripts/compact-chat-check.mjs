// Renderer fixture test: no real accounts, agents, or model calls.
import { chromium } from 'playwright';
import { preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 760 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
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
      runtime: { protocol: 22 },
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
  });
  await page.goto(server.resolvedUrls.local[0]);
  const progress = page.getByRole('button', { name: 'Ver progreso', exact: true });
  await progress.waitFor();
  assert.equal(await page.locator('.messages .tool').count(), 0);
  assert.equal(await page.locator('.messages .author').count(), 0);
  assert.equal(
    await progress.locator('.activity-current-text').innerText(),
    'Revisando la estructura del proyecto',
  );
  const composer = await page.locator('.composer').boundingBox();
  const context = await page.locator('.git-summary').boundingBox();
  const dock = await progress.boundingBox();
  assert.ok(dock.y + dock.height <= context.y);
  assert.ok(context.y - (dock.y + dock.height) < 10);
  assert.ok(context.y + context.height <= composer.y);
  assert.ok(dock.height <= 26);
  assert.equal(
    await page.locator('.task-signature').innerText(),
    'Personal\n5 h\n—\n·\nSonnet 5.5\n·\n↑— ↓—',
  );
  await progress.click();
  assert.equal(await page.locator('.activity-log .tool').count(), 2);
  await page.locator('.activity-log .tool-head').first().click();
  assert.equal(await page.locator('.activity-log .result').innerText(), '{}');
  await progress.click();
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
  await page.getByText('El proyecto usa', { exact: false }).waitFor();
  assert.equal(await page.locator('.task-signature-tokens').innerText(), '↑1,2k ↓340');
  assert.match(
    await page.locator('.task-signature-tokens').getAttribute('title'),
    /Entrada: 1234|Entrada: 1.234/,
  );
  const signature = await page.locator('.task-signature').boundingBox();
  const finishedComposer = await page.locator('.composer').boundingBox();
  assert.ok(signature.y >= finishedComposer.y + finishedComposer.height);
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Otra tarea');
  assert.equal(await page.locator('.task-signature-model').innerText(), 'Auto');
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('');
  assert.equal(await progress.count(), 0);
  assert.equal(await page.locator('.response-work').count(), 1);
  assert.equal(await page.locator('.response-work').getAttribute('open'), null);
  await page.getByText('Leyó 1 archivo y ejecutó 1 comando', { exact: true }).click();
  assert.equal(await page.locator('.response-work .tool').count(), 2);
  await page.getByText('Leyó 1 archivo y ejecutó 1 comando', { exact: true }).click();
  await page.screenshot({ path: 'artifacts/chat-compacto-respuesta.png' });
  // Existing final response must remain visible while the next process starts.
  await page.evaluate(() => {
    const f = window.compactFixture;
    f.session.status = 'starting';
    f.publish();
  });
  await page.getByText('Abriendo agente…', { exact: true }).waitFor();
  assert.ok(await page.getByText('El proyecto usa', { exact: false }).isVisible());
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
  await page.getByText('Esperando tu respuesta', { exact: true }).waitFor();
  assert.ok(await page.locator('.approval').isVisible());
  await page.setViewportSize({ width: 900, height: 650 });
  assert.ok((await progress.boundingBox()).height <= 26);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: progreso fijo de una línea, detalle accesible, resultado compacto, arranque y permisos visibles.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
