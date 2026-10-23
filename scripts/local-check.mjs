// Local provider UI regression. Isolated data, synthetic engine and models; no model downloads.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-local-ui-')));
const data = path.join(root, 'data'),
  models = path.join(root, 'models'),
  project = path.join(root, 'project');
await Promise.all([fs.mkdir(data), fs.mkdir(models), fs.mkdir(project)]);
await fs.writeFile(path.join(project, 'note.txt'), 'Local test');
await fs.writeFile(path.join(models, 'Qwen-fixture.gguf'), 'GGUFfixture');
const nestedModel = 'Qwen/model/Qwen-fixture.gguf';
await fs.mkdir(path.dirname(path.join(models, nestedModel)), { recursive: true });
await fs.writeFile(path.join(models, nestedModel), 'GGUFfixture');
const engine = path.join(data, 'local-engine/b11819');
const requests = path.join(root, 'local-requests.jsonl');
await fs.mkdir(engine, { recursive: true });
await fs.writeFile(
  path.join(engine, 'llama-server'),
  `#!/usr/bin/env node
const http=require('node:http');
const fs=require('node:fs');
const args=process.argv;
let round=0;
http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.end('ok');return;}
  let input='';
  for await(const chunk of req)input+=chunk;
  const body=JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify(body)+'\\n');
  const steps=[
    ['list_files',{path:'.'}],
    ['read_file',{path:'note.txt'}],
    ['write_file',{path:'output.txt',content:'Copia: Local test'}],
  ];
  const step=steps[round++];
  const choice=step
    ?{delta:{tool_calls:[{index:0,id:'local-tool-'+round,type:'function',function:{name:step[0],arguments:JSON.stringify(step[1])}}]},finish_reason:'tool_calls'}
    :{delta:{content:'Respuesta local verificada'},finish_reason:'stop'};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.end('data: '+JSON.stringify({choices:[choice]})+'\\n\\ndata: [DONE]\\n\\n');
}).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
  { mode: 0o755 },
);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [],
    projects: [{ id: 'p', name: 'Prueba local', path: project }],
    sessions: [],
    tools: {},
    selectedProject: 'p',
  }),
);
const bootstrap = path.join(root, 'diagnostics.cjs');
await fs.writeFile(
  bootstrap,
  "const { dialog } = require('electron'); dialog.showErrorBox = (title, message) => console.error(title + ': ' + message);\n",
);
let app, page;
const errors = [];
const until = async (read, description) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
};
try {
  app = await electron.launch({
    ...(process.env.CHECK_EXECUTABLE
      ? { executablePath: process.env.CHECK_EXECUTABLE }
      : { args: ['-r', bootstrap, '.'] }),
    env: {
      ...process.env,
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
      AGENT_DESK_DEV_URL: process.env.AGENT_DESK_DEV_URL ?? '',
    },
  });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, models);
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.desk);
  const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
  await page.getByRole('button', { name: 'Añadir cuenta', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Ajustes', exact: true })
    .getByRole('button', { name: 'Añadir cuenta', exact: true })
    .click();
  await page.getByLabel('Proveedor de la nueva cuenta').selectOption('local');
  await page.getByLabel('Nombre de la nueva cuenta').fill('Qwen local');
  await page.getByRole('button', { name: 'Crear perfil', exact: true }).click();
  const card = page.getByRole('region', { name: 'Cuenta Qwen local' });
  await card.getByRole('button', { name: 'Seleccionar carpeta', exact: true }).click();
  await card.getByText(models, { exact: true }).waitFor();
  await card.getByRole('listitem').getByText('Qwen-fixture', { exact: true }).waitFor();
  await card.getByRole('listitem').getByText('Qwen/model/Qwen-fixture', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Iniciar sesión', exact: true }).count(), 0);
  await card.getByLabel('Permitir herramientas del proyecto').click();
  await until(
    async () => (await call({ type: 'localStatus', profile: 'local-1' })).tools,
    'project tools to be enabled',
  );
  assert.equal((await call({ type: 'localStatus', profile: 'local-1' })).tools, true);
  await card.getByLabel('Contexto del modelo local', { exact: true }).selectOption('65536');
  await page.waitForTimeout(300);
  assert.equal((await call({ type: 'localStatus', profile: 'local-1' })).context, 65536);
  await card.getByLabel('Modelo local predeterminado', { exact: true }).selectOption(nestedModel);
  await page.waitForTimeout(300);
  assert.equal((await call({ type: 'localStatus', profile: 'local-1' })).defaultModel, nestedModel);
  await fs.mkdir('artifacts/local-ui', { recursive: true });
  await page.screenshot({ path: 'artifacts/local-ui/settings.png' });
  // Close the settings dialog with its normal keyboard control.
  await page.keyboard.press('Escape');
  // Onboarding creates the first chat after adding the account. Use the visible chat
  // instead of creating another over IPC while React still renders the previous composer.
  const snapshot = await call({ type: 'snapshot' });
  const session =
    snapshot.sessions.find((session) => session.id === snapshot.selectedSession) ??
    (await call({ type: 'newSession', projectId: 'p', profile: 'local-1' }));
  await call({ type: 'refreshModels', sessionId: session.id });
  await call({
    type: 'configureProvider',
    sessionId: session.id,
    config: { model: nestedModel },
  });
  const composer = page.getByRole('textbox', { name: 'Mensaje', exact: true });
  await composer.fill(
    'Lista la carpeta del proyecto, lee note.txt y crea output.txt con su contenido.',
  );
  await composer.press('Enter');
  const pending = await until(async () => {
    const state = await call({ type: 'snapshot' });
    const current = state.sessions.find((s) => s.id === session.id);
    return current?.approvals.length === 1 && current;
  }, 'local write approval');
  assert.equal(pending.status, 'waiting');
  assert.equal(pending.approvals[0].title, 'Escribir output.txt');
  assert.deepEqual(pending.approvals[0].input, {
    path: 'output.txt',
    content: 'Copia: Local test',
  });
  await assert.rejects(fs.access(path.join(project, 'output.txt')), { code: 'ENOENT' });
  assert.deepEqual(
    pending.messages
      .filter((m) => m.role === 'tool')
      .map((m) => [m.tool.tool, m.tool.status, m.tool.output]),
    [
      ['list_files', 'completed', JSON.stringify({ directory: project, entries: ['note.txt'] })],
      ['read_file', 'completed', 'Local test'],
      ['write_file', 'inProgress', undefined],
    ],
  );
  const readRequests = async () =>
    (await fs.readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const beforeApproval = await readRequests();
  assert.equal(
    beforeApproval.length,
    3,
    'The local agent waits for write approval before continuing.',
  );
  for (const request of beforeApproval) {
    assert.equal(request.model, nestedModel);
    assert.equal(request.messages[0].role, 'system');
    assert.ok(
      request.messages[0].content.includes(project),
      'The model receives the actual project directory.',
    );
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), [
      'list_files',
      'read_file',
      'run_command',
      'write_file',
    ]);
  }
  assert.equal(beforeApproval[1].messages.at(-1).role, 'tool');
  assert.equal(beforeApproval[1].messages.at(-1).tool_call_id, 'local-tool-1');
  assert.deepEqual(JSON.parse(beforeApproval[1].messages.at(-1).content), {
    directory: project,
    entries: ['note.txt'],
  });
  assert.equal(beforeApproval[2].messages.at(-1).tool_call_id, 'local-tool-2');
  assert.equal(beforeApproval[2].messages.at(-1).content, 'Local test');
  await call({
    type: 'approve',
    sessionId: session.id,
    requestId: pending.approvals[0].id,
    decision: 'accept',
  });
  await page
    .locator('.workspace')
    .getByText('Respuesta local verificada', { exact: true })
    .waitFor();
  await until(async () => {
    const state = await call({ type: 'snapshot' });
    return state.sessions.find((s) => s.id === session.id)?.status === 'ready';
  }, 'the completed local turn');
  assert.equal(await fs.readFile(path.join(project, 'output.txt'), 'utf8'), 'Copia: Local test');
  const completeRequests = await readRequests();
  assert.equal(completeRequests.length, 4);
  assert.equal(completeRequests[3].messages.at(-1).tool_call_id, 'local-tool-3');
  assert.equal(completeRequests[3].messages.at(-1).content, 'Archivo guardado.');
  await page.screenshot({ path: 'artifacts/local-ui/chat.png' });
  assert.equal((await call({ type: 'localStatus', profile: 'local-1' })).running, nestedModel);
  await call({ type: 'stop', sessionId: session.id });
  await call({ type: 'localUnload', profile: 'local-1' });
  assert.equal((await call({ type: 'localStatus', profile: 'local-1' })).running, undefined);
  assert.deepEqual(errors, []);
  console.log(
    'Local UI verified: account creation, folder picker, recursive catalog, nested default, context, project path and tool definitions, actual directory listing/file reading, approved file creation, nested-model chat streaming and unload.',
  );
} catch (error) {
  if (page) {
    console.error(await page.locator('body').innerText());
    console.error(
      JSON.stringify(await page.evaluate(() => window.desk.invoke({ type: 'snapshot' }))),
    );
    await page.screenshot({ path: 'artifacts/local-ui/failure.png' });
  }
  throw error;
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
