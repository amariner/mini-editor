// Renderer fixture test for the chat design: no real accounts, agents or model calls.
import { chromium } from 'playwright';
import { preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const server = await preview({ preview: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
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
  browser = await chromium.launch({ headless: true });
  for (const colorScheme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 860 }, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ answer, second }) => {
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
          runtime: { protocol: 22 },
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
      { answer, second },
    );
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByText('He bajado los últimos cambios', { exact: false }).waitFor();
    const summary = page.locator('.response-work > summary').first();
    assert.equal(
      (await summary.innerText()).replace(/\s+/g, ' ').trim(),
      'Leyó 1 archivo, hizo 1 búsqueda, ejecutó 2 comandos y editó 1 archivo 1 min 23 s',
    );
    assert.equal(await page.locator('.turn-changes').count(), 1);
    assert.match(await page.locator('.turn-changes').innerText(), /README\.md/);
    assert.equal(await page.locator('.md :not(pre) > code').first().innerText(), 'origin/main');
    assert.equal(await page.locator('a.md-link.path').count(), 1);
    assert.equal(await page.locator('a.md-link.url').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Pegar en la terminal' }).count(), 1);
    assert.ok((await page.locator('.md-code .tk-f').count()) >= 1);
    assert.equal(await page.locator('.md-table th').count(), 3);
    assert.equal(await page.locator('.md-callout.warning').count(), 1);
    assert.match(await page.locator('.task-signature').innerText(), /34%/);
    await page.screenshot({
      path: `artifacts/chat-v2-respuesta-${colorScheme === 'dark' ? 'oscuro' : 'claro'}.png`,
    });
    await page.locator('a.md-link.path').click();
    await page.locator('a.md-link.url').click();
    const actions = await page.evaluate(() => window.fixture.actions.map((a) => a.type));
    assert.ok(actions.includes('openPath') && actions.includes('browserNew'));
    if (colorScheme === 'dark') {
      await summary.click();
      await page.locator('.response-work .tool-head').filter({ hasText: 'Editó' }).click();
      await page.locator('.response-work pre.diff').waitFor();
      assert.equal(await page.locator('.response-work pre.diff .added').count(), 2);
      assert.equal(await page.locator('.response-work pre.diff .removed').count(), 1);
      await page.locator('.response-work').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'artifacts/chat-v2-pasos.png' });
      await summary.click();
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
      await page.getByText('Esperando tu respuesta', { exact: true }).waitFor();
      await page.locator('.approval').scrollIntoViewIfNeeded();
      assert.match(
        await page.locator('.approval').innerText(),
        /Siempre: Bash\(git branch -D:\*\)/,
      );
      await page.screenshot({ path: 'artifacts/chat-v2-permiso.png' });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForTimeout(400); // let colour transitions settle
      await page.screenshot({ path: 'artifacts/chat-v2-permiso-claro.png' });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(400);
      assert.equal(await page.getByRole('button', { name: 'Permitir', exact: true }).count(), 1);
      assert.equal(
        await page.getByRole('button', { name: 'Permitir siempre', exact: true }).count(),
        1,
      );
      await page.locator('.approval .primary').focus();
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
      const box = page.getByRole('textbox', { name: 'Mensaje', exact: true });
      await box.click();
      await box.pressSequentially('Revisa @chat');
      await page.locator('.slash-menu .file-option').first().waitFor();
      await page.screenshot({ path: 'artifacts/chat-v2-menciones.png' });
      await page.keyboard.press('Enter');
      assert.equal(await box.inputValue(), 'Revisa @src/chat.tsx ');
      await box.fill('');
      await page.keyboard.press('ArrowUp');
      assert.equal(await box.inputValue(), 'Borra la rama local');
      // /copy copies the last answer without sending anything.
      await box.fill('/copy');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await page.locator('.composer-flash').waitFor();
      assert.equal(await box.inputValue(), '');
      // ⌘K also finds text inside conversations.
      await page.keyboard.press('Meta+k');
      await page.getByPlaceholder('Buscar proyecto o sesión…').fill('reloj-virtual');
      assert.match(await page.locator('.palette-results').innerText(), /reloj-virtual/);
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
  await page.addInitScript(() => {
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
      runtime: { protocol: 22 },
      coordination: [],
    };
    window.desk = {
      subscribe: () => () => {},
      async invoke(action) {
        if (action.type === 'snapshot') return structuredClone(state);
        if (action.type === 'diff') return { repository: false };
        return true;
      },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByText('Corregido:', { exact: false }).waitFor();
  const codexSummary = page.locator('.response-work > summary');
  assert.equal(
    (await codexSummary.innerText()).replace(/\s+/g, ' ').trim(),
    'Leyó 1 archivo, ejecutó 1 comando y editó 1 archivo 47 s 1 error',
  );
  await codexSummary.click();
  assert.equal(await page.locator('.response-work .tool.failed').count(), 1);
  assert.match(await page.locator('.turn-changes').innerText(), /src\/dates\.ts/);
  assert.equal(await page.locator('.todo-panel').count(), 1);
  await page.screenshot({ path: 'artifacts/chat-v2-codex.png' });
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    'PASS: chat v2 — resumen, cambios, código, enlaces, permisos con teclado, menciones, historial y Codex estructurado.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
