import { createTestAccounts } from './test-accounts.mjs';
// Opt-in: real subscriptions, temporary project/data, never reads credentials.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
if (!process.env.AGENT_DESK_PROFILES_DIR)
  throw new Error('Define AGENT_DESK_PROFILES_DIR con los perfiles oficiales autenticados.');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-browser-live-')));
const folder = path.join(root, 'project');
await fs.mkdir(folder);
const server = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><title>Prueba local</title><h1>Vista previa local</h1><input aria-label="Nombre"><button onclick="document.querySelector(\'#result\').textContent=\'Hola \'+document.querySelector(\'input\').value">Saludar</button><p id="result">Sin enviar</p>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
let app, page;
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
try {
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, AGENT_DESK_DEV_URL: '', AGENT_DESK_DATA_DIR: path.join(root, 'data') },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.desk);
  await createTestAccounts(page);
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await call({ type: 'addProject' });
  let state = await call({ type: 'snapshot' });
  const projectId = state.selectedProject;
  const ids = [state.selectedSession];
  await call({ type: 'newSession', projectId, profile: 'codex' });
  ids.push((await call({ type: 'snapshot' })).selectedSession);
  await call({ type: 'configure', sessionId: ids[0], config: { model: 'haiku' } });
  for (const id of ids) await call({ type: 'start', sessionId: id });
  state = await call({ type: 'snapshot' });
  if (ids.some((id) => !state.sessions.find((s) => s.id === id).account))
    throw new Error('AUTH_REQUIRED: falta autenticación oficial; no se enviaron tareas.');
  const cs = state.sessions.find((s) => s.id === ids[1]);
  const model =
    cs.info.models.find((m) => m.value.includes('luna')) ?? cs.info.models.find((m) => m.isDefault);
  if (model)
    await call({
      type: 'configureCodex',
      sessionId: ids[1],
      config: {
        model: model.value,
        effort: model.supportedEffortLevels?.includes('low') ? 'low' : undefined,
      },
    });
  // Run each provider in the selected conversation, then verify background screenshots separately.
  for (const [i, id] of ids.entries()) {
    await call({ type: 'select', projectId, sessionId: id });
    const name = i ? 'Codex' : 'Claude';
    await call({
      type: 'send',
      sessionId: id,
      text: `Prueba breve y real del navegador integrado de Agent Desk. No leas ni modifiques archivos y no ejecutes comandos. Usa exclusivamente agent_desk browser: navigate a ${url}, inspect, fill del campo Nombre con '${name}', click Saludar, inspect para verificar 'Hola ${name}', y screenshot para comprobar la vista. No cierres la página. Responde brevemente con el resultado real.`,
    });
    const end = Date.now() + 150000;
    let done = false;
    while (Date.now() < end) {
      const s = (await call({ type: 'snapshot' })).sessions.find((s) => s.id === id);
      if (s.approvals.length)
        throw new Error(`${name}: unexpected approval ${JSON.stringify(s.approvals)}`);
      if (s.error) throw new Error(`${name}: ${s.error}`);
      if (s.status === 'ready' && s.messages.some((m) => m.role === 'assistant')) {
        done = true;
        console.log(
          name,
          s.messages
            .filter((m) => m.role === 'assistant')
            .at(-1)
            ?.blocks?.filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('') ?? s.messages.filter((m) => m.role === 'assistant').at(-1)?.text,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(done, `${name} timeout`);
    const result = await call({ type: 'browser', sessionId: id, input: { action: 'inspect' } });
    assert.ok(result.text.includes(`Hola ${name}`), JSON.stringify(result));
    const capture = await call({ type: 'browser', sessionId: id, input: { action: 'screenshot' } });
    assert.ok(Buffer.from(capture.image, 'base64').length > 1000);
    const s = (await call({ type: 'snapshot' })).sessions.find((s) => s.id === id);
    assert.ok(
      s.messages.some(
        (m) =>
          (m.role === 'tool' && m.text.includes('screenshot')) ||
          m.blocks?.some(
            (b) => b.type === 'tool_use' && b.input?.action === 'screenshot' && !b.isError,
          ),
      ),
      `${name} did not call screenshot`,
    );
  }
  assert.deepEqual(await fs.readdir(folder), []);
  console.log(
    'PASS LIVE: official Claude/Codex subscriptions navigated, inspected, filled, clicked, verified and captured the integrated page through MCP. No project files changed.',
  );
} finally {
  if (app) await app.close();
  await new Promise((r) => server.close(r));
}
