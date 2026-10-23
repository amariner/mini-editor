// Real Electron IPC, HTTP transport and encrypted persistence; no model requests or user accounts.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-mcp-electron-'));
const secret = 'fixture-mcp-token-not-a-real-credential';
let app, page;
const errors = [];
let requests = 0;
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${secret}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  let text = '';
  for await (const chunk of request) text += chunk;
  const message = JSON.parse(text);
  requests++;
  if (message.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'Fixture', version: '1' },
        }
      : {
          tools: [
            {
              name: 'read_notes',
              description: 'Lee notas del servidor de prueba',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        };
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
const call = (action) => page.evaluate((action) => window.desk.invoke(action), action);
async function untilSnapshot(predicate) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const state = await call({ type: 'snapshot' });
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    'No se alcanzó el estado MCP esperado: ' +
      JSON.stringify((await call({ type: 'snapshot' })).mcpConnections),
  );
}
async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: root,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.desk);
}
try {
  // Keep this loopback-only fixture independent from the host's corporate/system proxy.
  await fs.writeFile(
    path.join(root, 'network.json'),
    JSON.stringify({
      enabled: false,
      mode: 'system',
      protocol: 'http',
      host: '',
      port: 8080,
      username: '',
      caFile: '',
    }),
  );
  await fs.mkdir(path.join(root, 'project'));
  await fs.writeFile(
    path.join(root, 'state.json'),
    JSON.stringify({
      profiles: [{ id: 'codex', kind: 'codex', name: 'Prueba aislada' }],
      projects: [{ id: 'p', name: 'Proyecto MCP', path: path.join(root, 'project') }],
      sessions: [
        {
          id: 's',
          title: 'Chat MCP',
          projectId: 'p',
          profile: 'codex',
          messages: [],
          mode: 'chat',
        },
      ],
      selectedProject: 'p',
      selectedSession: 's',
      tools: {},
    }),
  );
  await launch();
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('tab', { name: 'Conexiones', exact: true }).click();
  await page.getByRole('button', { name: 'Añadir conexión', exact: true }).click();
  const form = page.getByRole('form', { name: 'Nueva conexión' });
  await form.getByLabel('Nombre', { exact: true }).fill('Notas del equipo');
  await form.getByLabel('Identidad').fill('Prueba local');
  await form.getByLabel('URL del servidor').fill(url);
  await form.getByRole('combobox', { name: /^Autenticación/ }).selectOption('headers');
  await form.getByLabel('Cabeceras: nombre 1').fill('Authorization');
  await form.getByLabel('Cabeceras: valor 1').fill(`Bearer ${secret}`);
  await form.getByRole('button', { name: 'Guardar conexión', exact: true }).click();
  const card = page.getByRole('article', { name: 'Notas del equipo', exact: true });
  await card.waitFor();
  await card.getByRole('button', { name: 'Comprobar', exact: true }).click();
  const checked = await untilSnapshot((state) => state.mcpConnections[0]?.status === 'connected');
  const saved = checked.mcpConnections[0];
  assert.equal(saved.status, 'connected', JSON.stringify(saved));
  assert.ok(saved.tools, JSON.stringify(saved));
  assert.equal(saved.tools[0].name, 'read_notes');
  assert.ok(requests >= 3);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
  await page
    .getByRole('region', { name: 'Conexiones del proyecto' })
    .getByRole('checkbox', { name: /Notas del equipo/ })
    .click();
  await untilSnapshot((state) => state.projects[0].mcpConnectionIds?.length === 1);
  await call({ type: 'setSessionMcpConnections', sessionId: 's', connectionIds: [] });
  assert.deepEqual((await call({ type: 'snapshot' })).sessions[0].mcpConnectionIds, []);
  await fs.mkdir('artifacts/mcp-ui', { recursive: true });
  await page.screenshot({ path: 'artifacts/mcp-ui/electron-connections.png' });
  await app.close();
  app = undefined;
  for (const file of await fs.readdir(path.join(root, 'mcp'))) {
    const data = await fs.readFile(path.join(root, 'mcp', file));
    assert.ok(!data.includes(Buffer.from(secret)), 'secrets must remain encrypted on disk');
  }
  await launch();
  let state = await call({ type: 'snapshot' });
  assert.equal(state.mcpConnections[0].status, 'unchecked');
  assert.deepEqual(state.projects[0].mcpConnectionIds, [saved.id]);
  assert.deepEqual(state.sessions[0].mcpConnectionIds, []);
  assert.equal((await call({ type: 'testMcpConnection', id: saved.id })).status, 'connected');
  await call({ type: 'setSessionMcpConnections', sessionId: 's', connectionIds: null });
  assert.equal((await call({ type: 'snapshot' })).sessions[0].mcpConnectionIds, undefined);
  await call({ type: 'deleteMcpConnection', id: saved.id });
  state = await call({ type: 'snapshot' });
  assert.deepEqual(state.mcpConnections, []);
  assert.deepEqual(state.projects[0].mcpConnectionIds, []);
  assert.deepEqual(await fs.readdir(path.join(root, 'mcp')), ['connections.json']);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: UI → IPC → HTTP MCP, discovery, encrypted credentials, assignments, restart and deletion.',
  );
} finally {
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
