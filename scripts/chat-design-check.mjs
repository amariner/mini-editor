// Renderer fixture test for the chat design: no real accounts, agents or model calls.
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
const answer = [
  'He bajado los últimos cambios de los dos repos y los dos están ya al día con `origin/main`.',
  '',
  '- **logicflow-lab**: estaba en `main` y han entrado 8 ficheros de documentación. Lo más destacable es la página nueva [docs/wiki/sistema-de-diseno.md](docs/wiki/sistema-de-diseno.md) y los cambios en el README.',
  '- **logicflows**: la rama `test/LF-116-reloj-virtual` ya no existe en el remoto porque se fusionó como un único commit, `ac1864b`. El último es `c681040` (docs: preparar la entrega de v0.5.0).',
  '  - Nuevo paquete `packages/design-tokens` y el tema de Keycloak.',
  '  - Revisa http://localhost:5173 para ver el arranque del dashboard.',
  '',
  'La rama local `test/LF-116-reloj-virtual` sigue existiendo. Su único commit (`4e609e4`) ya está en `main`, así que se puede borrar si quieres:',
  '',
  '```bash',
  'git branch -D test/LF-116-reloj-virtual',
  '```',
].join('\n');
const second = [
  '### Resumen de cambios',
  '',
  '| Repo | Commits | Estado |',
  '|:--|--:|:--|',
  '| `logicflow-lab` | 8 | al día |',
  '| `logicflows` | 17 | al día |',
  '',
  '> [!WARNING]',
  '> La versión **v0.5.0** cambia el formato de los tokens.',
  '',
  '```ts',
  "import { tokens } from '@logicflows/design-tokens';",
  '// Colores base del tema',
  'export function theme(dark: boolean) {',
  '  return dark ? tokens.dark : tokens.light; // 2 modos',
  '}',
  '```',
].join('\n');
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL });
  for (const colorScheme of process.env.DETAILS_ONLY ? [] : ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 860 }, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ answer, second, protocol }) => {
        const now = Date.now();
        const session = {
          id: 's',
          projectId: 'p',
          profile: 'claude-1',
          title: 'Actualizar repos',
          status: 'ready',
          mode: 'chat',
          approvals: [],
          stats: {
            cost: 0,
            turns: 2,
            inputTokens: 48200,
            outputTokens: 2310,
            durationMs: 1000,
            tokensReported: true,
            contextPercent: 34,
            contextTokens: 68000,
            contextMax: 200000,
          },
          messages: [
            {
              id: 'u1',
              role: 'user',
              text: 'Baja los últimos cambios de los dos repos y dime qué ha entrado',
              at: now - 600000,
            },
            {
              id: 'a1',
              role: 'assistant',
              text: '',
              model: 'claude-sonnet-4-5-20250929',
              blocks: [
                {
                  type: 'thinking',
                  text: 'Primero compruebo el estado de cada repo.',
                  final: true,
                },
                { type: 'text', text: 'Voy a revisar ambos repositorios.', final: true },
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'Bash',
                  input: {
                    command: 'git -C ../logicflow-lab pull --ff-only',
                    description: 'Actualizar logicflow-lab',
                  },
                  done: true,
                  ms: 2300,
                  result:
                    'Updating 3f2a1b0..9c8d7e6\nFast-forward\n 8 files changed, 412 insertions(+), 37 deletions(-)',
                },
                {
                  type: 'tool_use',
                  id: 't2',
                  name: 'Bash',
                  input: { command: 'git -C ../logicflows checkout main && git pull' },
                  done: true,
                  ms: 3100,
                  result: "Switched to branch 'main'\nAlready up to date.",
                },
                {
                  type: 'tool_use',
                  id: 't3',
                  name: 'Read',
                  input: { file_path: '/tmp/chat-design/docs/wiki/sistema-de-diseno.md' },
                  done: true,
                  result: '     1\t# Sistema de diseño',
                },
                {
                  type: 'tool_use',
                  id: 't4',
                  name: 'Grep',
                  input: { pattern: 'design-tokens', path: '/tmp/chat-design/packages' },
                  done: true,
                  result: 'packages/design-tokens/package.json',
                },
                {
                  type: 'tool_use',
                  id: 't5',
                  name: 'Edit',
                  input: {
                    file_path: '/tmp/chat-design/README.md',
                    old_string: '# LogicFlows\n\nVersión 0.4.0\nInstala con npm.',
                    new_string:
                      '# LogicFlows\n\nVersión 0.5.0\nInstala con npm.\nIncluye design-tokens.',
                  },
                  done: true,
                  result: 'ok',
                },
              ],
            },
            {
              id: 'a2',
              role: 'assistant',
              text: '',
              model: 'claude-sonnet-4-5-20250929',
              durationMs: 83000,
              blocks: [{ type: 'text', text: answer, final: true }],
            },
            {
              id: 'n1',
              role: 'system',
              kind: 'compact',
              text: 'Contexto compactado (automático) · 162k → 41k tokens',
            },
            { id: 'u2', role: 'user', text: 'Hazme una tabla resumen', at: now - 120000 },
            {
              id: 'a3',
              role: 'assistant',
              text: '',
              model: 'claude-sonnet-4-5-20250929',
              durationMs: 6000,
              blocks: [{ type: 'text', text: second, final: true }],
            },
          ],
        };
        const state = {
          profiles: [
            {
              id: 'claude-1',
              name: 'Personal',
              kind: 'claude',
              optimization: { level: 0, autoModel: false },
            },
          ],
          accounts: {},
          projects: [{ id: 'p', name: 'logicflows', path: '/tmp/chat-design' }],
          sessions: [session],
          selectedSession: 's',
          selectedProject: 'p',
          tools: {},
          dataDir: '/tmp/chat-design',
          runtime: { protocol },
          coordination: [],
        };
        const listeners = new Set();
        window.fixture = {
          session,
          state,
          actions: [],
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
            window.fixture.actions.push(action);
            if (action.type === 'snapshot') return structuredClone(state);
            if (action.type === 'diff')
              return {
                repository: true,
                branch: 'main',
                files: [],
                branches: ['main'],
                counts: {},
                commits: [],
                lines: { added: 12, removed: 3 },
              };
            if (action.type === 'listFiles')
              return ['src/main.tsx', 'src/chat.tsx', 'src/markdown.tsx', 'README.md'].filter((f) =>
                f.includes(action.query),
              );
            if (
              ['refreshUsage', 'openPath', 'browserNew', 'approve', 'refreshModels'].includes(
                action.type,
              )
            )
              return true;
            throw new Error(`Unexpected fixture action: ${action.type}`);
          },
        };
      },
      { answer, second, protocol },
    );
    await page.goto(server.resolvedUrls.local[0]);
    const chat = page.locator('.workspace');
    await chat.getByText('He bajado los últimos cambios', { exact: false }).waitFor();
    const summary = chat.locator('.response-work > summary').first();
    assert.equal(
      (await summary.innerText()).replace(/\s+/g, ' ').trim(),
      'Leyó 1 archivo, hizo 1 búsqueda, ejecutó 2 comandos y editó 1 archivo 1 min 23 s',
    );
    assert.equal(await chat.locator('.turn-changes').count(), 1);
    assert.equal(await chat.locator('.turn-changes-toggle').getAttribute('aria-expanded'), 'false');
    await chat.locator('.turn-changes-toggle').click();
    assert.match(await chat.locator('.turn-changes').innerText(), /README\.md/);
    await chat.locator('.turn-changes-toggle').click();
    assert.equal(await chat.locator('.md :not(pre) > code').first().innerText(), 'origin/main');
    assert.equal(await chat.locator('a.md-link.path').count(), 1);
    assert.equal(await chat.locator('a.md-link.url').count(), 1);
    assert.equal(await chat.getByRole('button', { name: 'Pegar en la terminal' }).count(), 1);
    assert.ok((await chat.locator('.md-code .tk-f').count()) >= 1);
    assert.equal(await chat.locator('.md-table th').count(), 3);
    assert.equal(await chat.locator('.md-callout.warning').count(), 1);
    assert.match(await chat.locator('.task-signature').innerText(), /34%/);
    await page.screenshot({
      path: `artifacts/chat-v2-respuesta-${colorScheme === 'dark' ? 'oscuro' : 'claro'}.png`,
    });
    await chat.locator('a.md-link.path').click();
    await chat.locator('a.md-link.url').click();
    const actions = await page.evaluate(() => window.fixture.actions.map((a) => a.type));
    assert.ok(actions.includes('openPath') && actions.includes('browserNew'));
    if (colorScheme === 'dark') {
      await summary.click();
      await chat.locator('.response-work .tool-head').filter({ hasText: 'Editó' }).click();
      await chat.locator('.response-work pre.diff').waitFor();
      assert.equal(await chat.locator('.response-work pre.diff .added').count(), 2);
      assert.equal(await chat.locator('.response-work pre.diff .removed').count(), 1);
      await chat.locator('.response-work').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'artifacts/chat-v2-pasos.png' });
      await summary.click();
      // Composer menus retain context, support arrows, and return focus without interrupting.
      const toolsToggle = chat.locator('.tools-toggle');
      assert.equal(await toolsToggle.getAttribute('aria-label'), 'Herramientas del chat');
      assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await chat.locator('.composer-chips').isVisible(), false);
      await toolsToggle.focus();
      await toolsToggle.press('Enter');
      assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await toolsToggle.getAttribute('aria-label'), 'Ocultar herramientas');
      const modelMenu = chat.getByRole('button', { name: 'Modelo', exact: true });
      await modelMenu.focus();
      await modelMenu.press('ArrowDown');
      const menu = chat.getByRole('dialog', { name: 'Modelo', exact: true });
      await menu.waitFor();
      // Opening a menu transfers focus on the next animation frame.
      await page.waitForFunction(
        (el) => el === document.activeElement,
        await menu.getByRole('button').first().elementHandle(),
        { timeout: 3000 },
      );
      assert.equal(
        await menu
          .getByRole('button')
          .first()
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press('End');
      assert.equal(
        await menu
          .getByRole('button')
          .last()
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press('Home');
      assert.equal(
        await menu
          .getByRole('button')
          .first()
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press('Escape');
      assert.equal(await modelMenu.evaluate((el) => el === document.activeElement), true);
      assert.equal(await menu.count(), 0);
      assert.equal(
        await page.evaluate(
          () => window.fixture.actions.filter((a) => a.type === 'interrupt').length,
        ),
        0,
      );
      await modelMenu.click();
      await chat
        .getByRole('textbox', { name: 'Mensaje', exact: true })
        .click({ position: { x: 10, y: 10 } });
      assert.equal(await menu.count(), 0);
      assert.equal(await toolsToggle.getAttribute('aria-expanded'), 'false');
      await page.setViewportSize({ width: 480, height: 620 });
      await toolsToggle.click();
      await chat.getByRole('button', { name: 'Esfuerzo de razonamiento', exact: true }).click();
      const effortBounds = await chat
        .getByRole('dialog', { name: 'Esfuerzo de razonamiento', exact: true })
        .boundingBox();
      const chatBounds = await chat.locator('.conversation').boundingBox();
      assert.ok(
        effortBounds.x >= chatBounds.x &&
          effortBounds.x + effortBounds.width <= chatBounds.x + chatBounds.width,
        'El menú debe caber en un chat estrecho',
      );
      assert.ok(effortBounds.y >= chatBounds.y, 'El menú debe caber en un chat de poca altura');
      await page.screenshot({ path: 'artifacts/chat-v20-menu-estrecho.png' });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      assert.equal(await chat.locator('.composer-chips').isVisible(), false);
      assert.equal(
        await chat
          .getByRole('button', { name: 'Herramientas del chat', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.setViewportSize({ width: 1180, height: 860 });
      // Working state: dock, plan strip and a permission card.
      await page.evaluate(() => {
        const f = window.fixture;
        f.session.status = 'waiting';
        f.session.todos = [
          { content: 'Actualizar logicflow-lab', status: 'completed' },
          {
            content: 'Borrar la rama fusionada',
            status: 'in_progress',
            activeForm: 'Borrando la rama fusionada',
          },
          { content: 'Revisar la documentación', status: 'pending' },
        ];
        f.session.messages.push(
          { id: 'u3', role: 'user', text: 'Borra la rama local', at: Date.now() - 14000 },
          {
            id: 'a4',
            role: 'assistant',
            text: '',
            blocks: [
              { type: 'text', text: 'Compruebo que el commit ya está en main.', final: true },
              {
                type: 'tool_use',
                id: 't9',
                name: 'Bash',
                input: { command: 'git branch --contains 4e609e4' },
                done: true,
                ms: 800,
                result: '* main',
              },
            ],
          },
        );
        f.session.approvals = [
          {
            id: 'perm',
            method: 'claude/permission',
            params: {},
            tool: 'Bash',
            input: {
              command: 'git branch -D test/LF-116-reloj-virtual',
              description: 'Borrar la rama local fusionada',
            },
            suggestions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash', ruleContent: 'git branch -D:*' }],
                behavior: 'allow',
                destination: 'localSettings',
              },
            ],
          },
        ];
        f.publish();
      });
      await chat.getByText('Esperando tu respuesta', { exact: true }).waitFor();
      const plan = chat.locator('.todo-panel > button');
      assert.equal(await plan.getAttribute('aria-expanded'), 'true');
      assert.equal(await chat.locator('.todo-panel .todos > li').count(), 3);
      await plan.click();
      assert.match(await plan.innerText(), /Borrando la rama fusionada/);
      await chat.locator('.approval').scrollIntoViewIfNeeded();
      assert.match(
        await chat.locator('.approval').innerText(),
        /Siempre: Bash\(git branch -D:\*\)/,
      );
      await page.screenshot({ path: 'artifacts/chat-v2-permiso.png' });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForTimeout(400); // let colour transitions settle
      await page.screenshot({ path: 'artifacts/chat-v2-permiso-claro.png' });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(400);
      assert.equal(await chat.getByRole('button', { name: 'Permitir', exact: true }).count(), 1);
      assert.equal(
        await chat.getByRole('button', { name: 'Permitir siempre', exact: true }).count(),
        1,
      );
      await chat.locator('.approval .primary').focus();
      await page.keyboard.press('2');
      const approve = await page.evaluate(() =>
        window.fixture.actions.filter((a) => a.type === 'approve').at(-1),
      );
      assert.equal(approve.decision, 'always');
      // @ mentions open a fuzzy file list from the project.
      await page.evaluate(() => {
        const f = window.fixture;
        f.session.approvals = [];
        f.session.status = 'ready';
        f.publish();
      });
      const box = chat.getByRole('textbox', { name: 'Mensaje', exact: true });
      await box.click();
      await box.pressSequentially('Revisa @chat');
      await chat.locator('.slash-menu .file-option').first().waitFor();
      await page.screenshot({ path: 'artifacts/chat-v2-menciones.png' });
      await page.keyboard.press('Enter');
      assert.equal(await box.inputValue(), 'Revisa @src/chat.tsx ');
      await box.fill('');
      await chat.locator('.slash-menu').waitFor({ state: 'hidden' });
      await page.keyboard.press('ArrowUp');
      assert.equal(await box.inputValue(), 'Borra la rama local');
      // /copy copies the last answer without sending anything.
      await box.fill('/copy');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await chat.locator('.composer-flash').waitFor();
      assert.equal(await box.inputValue(), '');
      // ⌘K also finds text inside conversations.
      await page.keyboard.press('Meta+k');
      await page.getByPlaceholder('Buscar proyecto o sesión…').fill('reloj-virtual');
      const searchResults = page.locator('.palette-results[aria-busy="false"]');
      await searchResults
        .getByRole('option')
        .filter({ hasText: 'reloj-virtual' })
        .first()
        .waitFor();
      assert.match(await searchResults.innerText(), /reloj-virtual/);
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Codex: structured items, reasoning summary, failed command and plan.
  const page = await browser.newPage({
    viewport: { width: 1180, height: 860 },
    colorScheme: 'dark',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((protocol) => {
    const session = {
      id: 'c',
      projectId: 'p',
      profile: 'codex',
      title: 'Arreglar pruebas',
      status: 'ready',
      mode: 'chat',
      approvals: [],
      reference: 'thread',
      codexConfig: {
        model: 'default',
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        personality: 'none',
        developerInstructions: '',
      },
      todos: [
        { content: 'Reproducir el fallo', status: 'completed' },
        { content: 'Corregir el cálculo', status: 'in_progress' },
      ],
      messages: [
        { id: 'u', role: 'user', text: 'Las pruebas de fechas fallan, arréglalas' },
        {
          id: 'r',
          role: 'assistant',
          text: '',
          blocks: [{ type: 'thinking', text: 'El fallo parece de zona horaria.', final: true }],
        },
        {
          id: 'x1',
          role: 'tool',
          text: '$ sed -n 1,80p src/dates.ts',
          tool: {
            kind: 'command',
            command: 'sed -n 1,80p src/dates.ts',
            status: 'completed',
            exitCode: 0,
            actions: [{ type: 'read', path: '/tmp/codex/src/dates.ts' }],
          },
        },
        {
          id: 'x2',
          role: 'tool',
          text: '$ npm test',
          tool: {
            kind: 'command',
            command: 'npm test',
            status: 'failed',
            exitCode: 1,
            durationMs: 5400,
            output: 'FAIL tests/dates.test.ts\n  ✕ convierte a UTC',
          },
        },
        {
          id: 'x3',
          role: 'tool',
          text: 'Cambios de archivos · /tmp/codex/src/dates.ts',
          tool: {
            kind: 'edit',
            status: 'completed',
            files: [
              {
                path: '/tmp/codex/src/dates.ts',
                kind: 'update',
                diff: '@@ -3,2 +3,2 @@\n-  return d.getHours();\n+  return d.getUTCHours();',
              },
            ],
          },
        },
        {
          id: 'a',
          role: 'assistant',
          text: 'Corregido: `toUtc` usaba la hora local. Ahora usa `getUTCHours()`.',
          durationMs: 47000,
        },
      ],
    };
    const state = {
      profiles: [{ id: 'codex', name: 'ChatGPT', kind: 'codex' }],
      accounts: {},
      projects: [{ id: 'p', name: 'fechas', path: '/tmp/codex' }],
      sessions: [session],
      selectedSession: 'c',
      selectedProject: 'p',
      tools: {},
      dataDir: '/tmp/codex',
      runtime: { protocol },
      coordination: [],
      browsers: [
        {
          id: 'preview',
          projectId: 'p',
          sessionId: 'c',
          url: 'https://example.com',
          title: 'Preview',
          zoom: 1,
        },
      ],
    };
    const listeners = new Set();
    window.detailsFixture = {
      state,
      publish: () => {
        for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
      },
      openBrowser: () => {
        for (const fn of listeners) fn({ type: 'browserOpened', tabId: 'preview' });
      },
    };
    window.desk = {
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async invoke(action) {
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'diff') return { repository: false };
        return true;
      },
    };
  }, protocol);
  await page.goto(server.resolvedUrls.local[0]);
  const chat = page.locator('.workspace');
  await chat.getByText('Corregido:', { exact: false }).waitFor();
  const codexSummary = chat.locator('.response-work > summary');
  assert.equal(
    (await codexSummary.innerText()).replace(/\s+/g, ' ').trim(),
    'Leyó 1 archivo, ejecutó 1 comando y editó 1 archivo 47 s 1 error',
  );
  await codexSummary.click();
  assert.equal(await chat.locator('.response-work .tool.failed').count(), 1);
  await chat.locator('.turn-changes-toggle').click();
  assert.match(await chat.locator('.turn-changes').innerText(), /src\/dates\.ts/);
  assert.equal(await chat.locator('.todo-panel').count(), 1);
  await page.getByRole('button', { name: 'Detalles del chat', exact: true }).click();
  assert.deepEqual(errors, []);
  await chat.getByRole('complementary', { name: 'Detalles del chat' }).waitFor();
  assert.match(await chat.locator('.chat-details').innerText(), /Entorno/);
  assert.equal(await chat.locator('.chat-details details').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Cerrar detalles' }).count(), 0);
  assert.doesNotMatch(
    await chat.locator('.chat-details').innerText(),
    /Sin datos|Sin rama|default|Sin información/,
  );
  const toggleBox = await page
    .getByRole('button', { name: 'Detalles del chat', exact: true })
    .boundingBox();
  const gridBox = await page.getByRole('button', { name: 'Multichat', exact: true }).boundingBox();
  assert.ok(toggleBox.x < gridBox.x && Math.abs(toggleBox.y - gridBox.y) < 3);
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  await page.locator('.browser-pane').waitFor();
  assert.equal(await chat.locator('.chat-details').count(), 0);
  await page.getByRole('button', { name: 'Detalles del chat', exact: true }).click();
  assert.equal(await page.locator('.browser-pane').count(), 0);
  await page.evaluate(() => window.detailsFixture.openBrowser());
  await page.locator('.browser-pane').waitFor();
  assert.equal(await chat.locator('.chat-details').count(), 0);
  await page.getByRole('button', { name: 'Detalles del chat', exact: true }).click();
  await page.evaluate(() => {
    window.detailsFixture.state.sessions[0].stats = {
      contextPercent: 4,
      contextTokens: 16800,
      contextMax: 475000,
      cost: 0,
      inputTokens: 79700,
      outputTokens: 391,
      tokensReported: true,
      turns: 1,
      durationMs: 21000,
    };
    window.detailsFixture.publish();
  });
  await page.waitForFunction(() => document.querySelector('.chat-details progress'));
  assert.equal(await chat.locator('.chat-details details').count(), 2);

  await page.screenshot({ path: 'artifacts/chat-details-wide.png' });
  await page.getByRole('button', { name: 'Detalles del chat', exact: true }).click();
  assert.equal(await chat.locator('.chat-details').count(), 0);
  await chat.locator('.tools-toggle').click();
  await chat.getByRole('button', { name: 'Velocidad de respuesta', exact: true }).click();
  assert.match(
    await chat.getByRole('dialog', { name: 'Velocidad de respuesta' }).innerText(),
    /mayor consumo/,
  );
  await chat.getByRole('button', { name: 'Activar modo rápido' }).click();

  await page.setViewportSize({ width: 760, height: 800 });
  await page.getByRole('button', { name: 'Detalles del chat', exact: true }).click();
  const panelBounds = await chat.locator('.chat-details').boundingBox();
  assert.ok(panelBounds && panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 760);
  await page.screenshot({ path: 'artifacts/chat-details-narrow.png' });
  await page.getByRole('button', { name: 'Detalles del chat', exact: true }).click();

  await page.screenshot({ path: 'artifacts/chat-v2-codex.png' });
  await page.getByRole('button', { name: 'Multichat', exact: true }).click();
  const card = page.locator('.multichat-card').first();
  const detailsToggle = card.getByRole('button', { name: 'Detalles del chat', exact: true });
  await detailsToggle.click();
  await card.locator('.chat-details').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await card.locator('.chat-details').count(), 0);
  assert.ok(await detailsToggle.evaluate((el) => el === document.activeElement));

  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    'PASS: chat v2 — resumen, cambios, código, enlaces, permisos con teclado, menciones, historial y Codex estructurado.',
  );
} finally {
  await browser?.close();
  await server.close();
  if (testBuild) await fs.rm(testBuild, { recursive: true, force: true });
}
