// Renderer-only MCP regression: isolated state, no commands, credentials or network requests.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-mcp-ui-'));
let browser;
let server;
try {
  await build({ build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: buildDir },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  await fs.mkdir('artifacts/mcp-ui', { recursive: true });
  for (const [colorScheme, width] of [
    ['dark', 1200],
    ['light', 1200],
    ['dark', 500],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ protocol }) => {
        const state = {
          profiles: [{ id: 'claude-1', name: 'Claude', kind: 'claude' }],
          accounts: { 'claude-1': { status: 'signedIn' } },
          projects: [{ id: 'p', name: 'Mi proyecto', path: '/tmp/mcp-fixture' }],
          sessions: [
            {
              id: 's',
              projectId: 'p',
              profile: 'claude-1',
              title: 'Mi chat',
              status: 'ready',
              mode: 'chat',
              messages: [],
              approvals: [],
            },
          ],
          selectedProject: 'p',
          selectedSession: 's',
          defaultProfile: 'claude-1',
          tools: {},
          dataDir: '/tmp/mcp-fixture',
          runtime: { protocol },
          theme: 'system',
          coordination: [],
          mcpConnections: [],
        };
        const listeners = new Set();
        const emit = () => {
          for (const listener of listeners)
            listener({ type: 'state', state: structuredClone(state) });
        };
        let resolveAuth;
        window.fixture = { state, actions: [], fail: '', emit };
        window.desk = {
          subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          async invoke(action) {
            window.fixture.actions.push(action);
            if (action.type === 'snapshot') return structuredClone(state);
            if (action.type === 'diff') return { repository: false };
            if (action.type === window.fixture.fail) throw new Error('Error de prueba de MCP');
            let result = { ok: true };
            if (action.type === 'saveMcpConnection') {
              const input = action.connection;
              const previous = state.mcpConnections.find((item) => item.id === input.id);
              const record = {
                ...input,
                id: input.id || `mcp-${state.mcpConnections.length + 1}`,
                revision: (previous?.revision || 0) + 1,
                status: 'unchecked',
                envKeys:
                  input.env === undefined
                    ? (previous?.envKeys ?? [])
                    : Object.keys(input.env ?? {}),
                headerKeys:
                  input.headers === undefined
                    ? (previous?.headerKeys ?? [])
                    : Object.keys(input.headers ?? {}),
              };
              delete record.env;
              delete record.headers;
              state.mcpConnections = [
                ...state.mcpConnections.filter((item) => item.id !== record.id),
                record,
              ];
              result = record;
            }
            if (action.type === 'testMcpConnection') {
              const record = state.mcpConnections.find((item) => item.id === action.id);
              record.status = 'checking';
              emit();
              await new Promise((resolve) => setTimeout(resolve, 250));
              record.status = 'connected';
              record.checkedAt = Date.now();
              record.tools = [
                { name: 'search_docs', description: 'Busca documentos en el espacio del equipo.' },
              ];
              result = record;
            }
            if (action.type === 'setProjectMcpConnections') {
              state.projects.find((item) => item.id === action.projectId).mcpConnectionIds =
                action.connectionIds;
              state.sessions[0].mcpPending = true;
            }
            if (action.type === 'setSessionMcpConnections') {
              const session = state.sessions.find((item) => item.id === action.sessionId);
              if (action.connectionIds === null) delete session.mcpConnectionIds;
              else session.mcpConnectionIds = action.connectionIds;
              session.mcpPending = true;
            }
            if (action.type === 'authenticateMcpConnection') {
              const record = state.mcpConnections.find((item) => item.id === action.id);
              record.authenticating = true;
              emit();
              await new Promise((resolve) => {
                resolveAuth = resolve;
              });
              result = record;
            }
            if (action.type === 'cancelMcpAuthentication') {
              state.mcpConnections.find((item) => item.id === action.id).authenticating = false;
              resolveAuth?.();
            }
            if (action.type === 'deleteMcpConnection') {
              state.mcpConnections = state.mcpConnections.filter((item) => item.id !== action.id);
              for (const item of [...state.projects, ...state.sessions])
                if (item.mcpConnectionIds)
                  item.mcpConnectionIds = item.mcpConnectionIds.filter((id) => id !== action.id);
            }
            emit();
            return structuredClone(result);
          },
        };
      },
      { protocol },
    );
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    await page.getByRole('tab', { name: 'Conexiones', exact: true }).click();
    await page.getByRole('button', { name: 'Añadir la primera conexión', exact: true }).click();
    const form = page.getByRole('form', { name: 'Nueva conexión' });
    await form.locator('.mcp-import > summary').click();
    await form.getByLabel('Configuración de un servidor').fill('{ broken');
    await form.getByRole('button', { name: 'Usar configuración' }).click();
    await form.getByRole('alert').filter({ hasText: 'El JSON no es válido' }).waitFor();
    await form
      .getByLabel('Configuración de un servidor')
      .fill('{"mcpServers":{"a":{"url":"https://example.test/mcp"},"b":{"command":"node"}}}');
    await form.getByRole('button', { name: 'Usar configuración' }).click();
    await form.getByRole('alert').filter({ hasText: 'un solo servidor' }).waitFor();
    await form
      .getByLabel('Configuración de un servidor')
      .fill(
        '{"mcpServers":{"Documentos":{"url":"https://example.test/mcp","headers":{"Authorization":"Bearer fixture-only"}}}}',
      );
    await form.getByRole('button', { name: 'Usar configuración' }).click();
    assert.equal(await form.getByLabel('Configuración de un servidor').inputValue(), '');
    assert.equal(await form.getByLabel('Cabeceras: valor 1').getAttribute('type'), 'password');
    await form.getByLabel('Identidad').fill('Cuenta del equipo');
    await form.getByRole('button', { name: 'Guardar conexión' }).click();
    const card = page.getByRole('article', { name: 'Documentos', exact: true });
    await card.waitFor();
    assert.equal(await card.innerText().then((value) => value.includes('fixture-only')), false);
    await card.getByRole('button', { name: 'Editar Documentos' }).click();
    const edit = page.getByRole('form', { name: 'Editar conexión' });
    assert.equal(await edit.getByLabel('Cabeceras: valores guardados').inputValue(), 'preserve');
    assert.equal(await edit.locator('input[type="password"]').count(), 0);
    await edit.getByRole('button', { name: 'Guardar conexión' }).click();
    const preserved = await page.evaluate(() =>
      window.fixture.actions.filter((action) => action.type === 'saveMcpConnection').at(-1),
    );
    assert.equal(
      Object.hasOwn(preserved.connection, 'headers'),
      false,
      'untouched secrets must be omitted',
    );
    await card.getByRole('button', { name: 'Editar Documentos' }).click();
    await edit.getByLabel('Cabeceras: valores guardados').selectOption('clear');
    await edit.getByRole('button', { name: 'Guardar conexión' }).click();
    assert.equal(
      await page.evaluate(
        () =>
          window.fixture.actions.filter((action) => action.type === 'saveMcpConnection').at(-1)
            .connection.headers,
      ),
      null,
    );
    await card.getByRole('button', { name: 'Comprobar', exact: true }).click();
    await card.getByRole('status').filter({ hasText: 'Comprobando' }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Editar Documentos' }).isDisabled(), true);
    await card.getByRole('status').filter({ hasText: 'Comprobada' }).waitFor();
    await card.locator('.mcp-tools > summary').click();
    await card.getByText('search_docs', { exact: true }).waitFor();
    await page
      .getByRole('region', { name: 'Conexiones del proyecto', exact: true })
      .getByRole('checkbox', { name: /Documentos/ })
      .check();
    assert.deepEqual(await page.evaluate(() => window.fixture.state.projects[0].mcpConnectionIds), [
      'mcp-1',
    ]);
    await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
    await page.getByRole('button', { name: 'Herramientas del chat', exact: true }).click();
    await page.getByRole('button', { name: 'Conexiones del chat', exact: true }).click();
    const chat = page.getByRole('region', { name: 'Conexiones del chat', exact: true });
    await chat.waitFor();
    assert.equal(await chat.getByRole('checkbox', { name: /Documentos/ }).isDisabled(), true);
    await chat.getByLabel('Conexiones de este chat').selectOption('custom');
    await chat.getByRole('checkbox', { name: /Documentos/ }).uncheck();
    assert.deepEqual(
      await page.evaluate(() => window.fixture.state.sessions[0].mcpConnectionIds),
      [],
    );
    await chat.getByLabel('Conexiones de este chat').selectOption('inherit');
    assert.equal(
      await page.evaluate(() => window.fixture.state.sessions[0].mcpConnectionIds),
      undefined,
    );
    await chat.getByRole('status').filter({ hasText: 'Cambios pendientes' }).waitFor();
    await page.evaluate(() => {
      window.fixture.state.sessions[0].profile = 'gemini-1';
      window.fixture.emit();
    });
    await chat.getByText(/Este chat no admite/).waitFor();
    assert.equal(await chat.getByLabel('Conexiones de este chat').isDisabled(), true);
    await page.evaluate(() => {
      window.fixture.state.sessions[0].profile = 'claude-1';
      window.fixture.fail = 'testMcpConnection';
      window.fixture.emit();
    });
    await card.getByRole('button', { name: 'Comprobar', exact: true }).click();
    await card.getByRole('alert').filter({ hasText: 'Error de prueba' }).waitFor();
    await page.evaluate(() => {
      window.fixture.fail = '';
    });
    await card.getByRole('button', { name: 'Editar Documentos' }).click();
    await edit.getByLabel('Autenticación').selectOption('oauth');
    await edit.getByRole('button', { name: 'Guardar conexión' }).click();
    await card.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await card.getByRole('status').filter({ hasText: 'Esperando autorización' }).waitFor();
    await card.getByRole('button', { name: 'Cancelar autorización' }).click();
    await card.getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Añadir conexión', exact: true }).click();
    await form.getByLabel('Nombre', { exact: true }).fill('Archivos locales');
    await form.getByLabel('Tipo de servidor').selectOption('stdio');
    await form.getByLabel('Comando', { exact: true }).fill('node');
    await form.getByLabel('Argumentos').fill('/tmp/mcp-fixture/server.mjs\n--read-only');
    await form.getByLabel('Variables de entorno: nombre 1').fill('API_KEY');
    await form.getByLabel('Variables de entorno: valor 1').fill('local-fixture-only');
    await form.getByRole('button', { name: 'Guardar conexión' }).click();
    const local = page.getByRole('article', { name: 'Archivos locales', exact: true });
    await local.waitFor();
    const localInput = await page.evaluate(
      () =>
        window.fixture.actions.filter((action) => action.type === 'saveMcpConnection').at(-1)
          .connection,
    );
    assert.deepEqual(localInput.args, ['/tmp/mcp-fixture/server.mjs', '--read-only']);
    assert.deepEqual(localInput.env, { API_KEY: 'local-fixture-only' });
    await page.getByRole('dialog', { name: 'Ajustes', exact: true }).evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: `artifacts/mcp-ui/${colorScheme}-${width}.png` });
    assert.equal(
      await page
        .getByRole('dialog', { name: 'Ajustes', exact: true })
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
      'no horizontal scrolling',
    );
    await card.getByRole('button', { name: 'Eliminar Documentos', exact: true }).click();
    await card.getByRole('button', { name: 'Conservar', exact: true }).click();
    assert.equal(await card.count(), 1);
    await card.getByRole('button', { name: 'Eliminar Documentos', exact: true }).click();
    await card.getByRole('button', { name: 'Eliminar conexión', exact: true }).click();
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(
      await page.evaluate(() => window.fixture.state.projects[0].mcpConnectionIds),
      [],
    );
    await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
    await page.evaluate(() => {
      const session = window.fixture.state.sessions[0];
      session.status = 'waiting';
      session.approvals = [
        {
          id: 'form',
          method: 'mcpServer/elicitation/request',
          params: {
            mode: 'form',
            serverName: 'Notas',
            message: 'Completa los datos',
            requestedSchema: {
              type: 'object',
              required: ['amount', 'include'],
              properties: {
                amount: { type: 'integer', title: 'Cantidad', minimum: 1, maximum: 5 },
                include: { type: 'boolean', title: 'Incluir notas' },
                toString: {
                  type: 'array',
                  title: 'Etiquetas',
                  items: { anyOf: [{ const: 'a', title: 'Etiqueta A' }] },
                },
              },
            },
          },
        },
      ];
      window.fixture.emit();
    });
    const elicitation = page.getByRole('region', { name: 'Solicitud MCP', exact: true });
    await elicitation.waitFor();
    assert.equal(
      await elicitation.getByRole('button', { name: 'Enviar respuesta' }).isDisabled(),
      true,
    );
    await elicitation.getByLabel('Cantidad').fill('6');
    await elicitation.getByLabel('Incluir notas').selectOption('false');
    assert.equal(
      await elicitation.getByRole('button', { name: 'Enviar respuesta' }).isDisabled(),
      true,
    );
    await elicitation.getByLabel('Cantidad').fill('2');
    await elicitation.getByLabel('Etiquetas').selectOption(['a']);
    await elicitation.getByRole('button', { name: 'Enviar respuesta' }).click();
    assert.deepEqual(
      await page.evaluate(
        () => window.fixture.actions.filter((a) => a.type === 'approve').at(-1).answers,
      ),
      { amount: '2', include: 'false', toString: '["a"]' },
    );
    await page.evaluate(() => {
      window.fixture.state.sessions[0].approvals = [
        {
          id: 'url',
          method: 'mcpServer/elicitation/request',
          params: {
            mode: 'url',
            serverName: 'Notas',
            message: 'Autoriza el servicio',
            url: 'https://example.test/authorize',
          },
        },
      ];
      window.fixture.emit();
    });
    assert.equal(
      await elicitation.getByRole('button', { name: 'He completado los pasos' }).isDisabled(),
      true,
    );
    await elicitation.getByRole('button', { name: 'Abrir en el navegador' }).click();
    await elicitation.getByRole('button', { name: 'He completado los pasos' }).click();
    assert.equal(
      await page.evaluate(() =>
        window.fixture.actions.some(
          (a) => a.type === 'openMcpElicitation' && a.requestId === 'url',
        ),
      ),
      true,
    );
    await page.evaluate(() => {
      window.fixture.state.sessions[0].approvals = [
        {
          id: 'unsupported',
          method: 'mcpServer/elicitation/request',
          params: {
            requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
          },
        },
      ];
      window.fixture.emit();
    });
    await elicitation.getByRole('alert').waitFor();
    await elicitation.getByRole('button', { name: 'Rechazar' }).click();
    assert.equal(
      await page.evaluate(
        () => window.fixture.actions.filter((a) => a.type === 'approve').at(-1).decision,
      ),
      'decline',
    );
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: MCP HTTP/stdio forms, JSON validation, secret preservation/clear, test/auth/cancel/error, project defaults, chat overrides/inheritance, pending/unsupported states, deletion, responsive light/dark UI.',
  );
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(buildDir, { recursive: true, force: true });
}
