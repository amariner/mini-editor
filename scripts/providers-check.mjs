// Synthetic local accounts only: no real API key, Google login, requests, or charges.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-providers-ui-')));
const data = path.join(root, 'data'),
  project = path.join(root, 'project');
await fs.mkdir(data);
await fs.mkdir(project);
await fs.mkdir(path.join(root, 'references'));
await fs.writeFile(path.join(root, 'references/note.txt'), 'Referencia externa verificada');
const fake = path.join(root, 'fake-gemini');
await fs.writeFile(
  fake,
  `#!/usr/bin/env node
const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path');let promptId;
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,authMethods:[{id:'oauth-personal'}]}});
else if(m.method==='authenticate'){if(fs.existsSync(path.join(process.env.GEMINI_CLI_HOME,'reject-client'))){send({id:m.id,error:{code:-32000,message:'This client is no longer supported for Gemini Code Assist for individuals.'}});return;}const dir=path.join(process.env.GEMINI_CLI_HOME,'.gemini');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'oauth_creds.json'),'{"refresh_token":"fixture-only"}');fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}}}));fs.writeFileSync(path.join(dir,'google_accounts.json'),'{"active":"fixture@example.test"}');send({id:m.id,result:{}});}
else if(m.method==='session/new'||m.method==='session/load')send({id:m.id,result:{sessionId:'fixture-g',models:{availableModels:[{modelId:'gemini-test',name:'Gemini prueba'}],currentModelId:'gemini-test'}}});
else if(m.method==='session/set_model')send({id:m.id,result:{}});
else if(m.method==='session/prompt'){promptId=m.id;send({id:70,method:'session/request_permission',params:{sessionId:'fixture-g',toolCall:{title:'Leer archivo de prueba'},options:[{kind:'allow_once',optionId:'once'}]}});}
else if(m.id===70){send({method:'session/update',params:{sessionId:'fixture-g',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result.outcome.optionId==='once'?'Respuesta Gemini verificada':'Acción rechazada'}}}});send({id:promptId,result:{stopReason:'end_turn'}});}
});\n`,
  { mode: 0o700 },
);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [
      { id: 'openrouter-1', kind: 'openrouter', name: 'Router prueba' },
      { id: 'gemini-1', kind: 'gemini', name: 'Google prueba' },
    ],
    defaultProfile: 'openrouter-1',
    projects: [{ id: 'p', name: 'Proyecto pruebas', path: project }],
    sessions: [{ id: 's', profile: 'openrouter-1', projectId: 'p', title: 'Prueba', messages: [] }],
    selectedProject: 'p',
    selectedSession: 's',
    tools: { gemini: fake },
  }),
);
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('UI state timeout');
}
async function launch() {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  await app.evaluate(({ session }) => {
    let round = 0;
    session.defaultSession.protocol.handle('https', async (request) => {
      const url = request.url;
      if (!url.startsWith('https://openrouter.ai/api/v1/')) throw Error('Unexpected origin');
      if (url.endsWith('/key'))
        return Response.json({ data: { usage: 1.25, limit: 10, limit_remaining: 8.75 } });
      if (url.includes('/models'))
        return Response.json({
          data: [
            {
              id: 'test/coder:free',
              name: 'Programador gratis',
              description: 'Modelo de programación para pruebas.',
              pricing: { prompt: '0', completion: '0' },
              architecture: { input_modalities: ['text'], output_modalities: ['text'] },
              supported_parameters: ['tools'],
            },
            ...(url.includes('category=programming')
              ? []
              : [
                  {
                    id: 'test/writer',
                    name: 'Redactor de pago',
                    description: 'Uso general.',
                    pricing: { prompt: '0.000001', completion: '0.000003' },
                    supported_parameters: [],
                  },
                ]),
          ],
        });
      if (url.endsWith('/chat/completions')) {
        round++;
        const event =
          round === 1
            ? {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'write1',
                          function: {
                            name: 'write_file',
                            arguments: JSON.stringify({
                              path: 'resultado.txt',
                              content: 'Prueba aprobada',
                            }),
                          },
                        },
                        {
                          index: 1,
                          id: 'external-directory',
                          function: {
                            name: 'list_files',
                            arguments: JSON.stringify({ path: '../references' }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0 },
              }
            : round === 2
              ? {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'external-file',
                            function: {
                              name: 'read_file',
                              arguments: JSON.stringify({ path: '../references/note.txt' }),
                            },
                          },
                        ],
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                }
              : {
                  choices: [
                    {
                      delta: { content: 'Respuesta OpenRouter verificada' },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: { prompt_tokens: 200, completion_tokens: 20, cost: 0 },
                };
        return new Response('data: ' + JSON.stringify(event) + '\n\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      throw Error('Unexpected route');
    });
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.desk);
}
try {
  await launch();
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  const router = page.getByRole('region', { name: 'Cuenta Router prueba' }); // section aria-label maps to region
  await router.getByLabel('Clave API de Router prueba').fill('sk-or-fixture-not-real');
  await router.getByRole('button', { name: 'Conectar OpenRouter', exact: true }).click();
  await until(
    async () => (await call({ type: 'snapshot' })).accounts['openrouter-1'].status === 'signedIn',
  );
  await router.locator('summary').click();
  await router.getByLabel('Uso de los modelos de Router prueba').selectOption('programming');
  await router.getByLabel('Mostrar solo modelos gratuitos').check();
  await router
    .locator('.provider-model-row')
    .filter({ hasText: 'Programador gratis' })
    .getByRole('checkbox')
    .check();
  await router.getByRole('button', { name: 'Guardar selección', exact: true }).click();
  await router.getByText('Selección guardada', { exact: true }).waitFor();
  await fs.mkdir('artifacts', { recursive: true });
  await page.locator('.account-settings').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'artifacts/provider-settings.png' });
  const google = page.getByRole('region', { name: 'Cuenta Google prueba' });
  await google.getByRole('button', { name: 'Iniciar sesión con Google', exact: true }).click();
  await until(
    async () => (await call({ type: 'snapshot' })).accounts['gemini-1'].status === 'signedIn',
  );
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Mensaje', exact: true })
    .fill('Crea un archivo de prueba');
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Permitir una vez', exact: true }).click();
  await page.getByText('Leer fuera del proyecto', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Permitir carpeta en este chat', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/provider-external-permission.png' });
  await page.getByRole('button', { name: 'Permitir carpeta en este chat', exact: true }).click();
  await page.getByText('Respuesta OpenRouter verificada', { exact: true }).waitFor();
  assert.equal(await fs.readFile(path.join(project, 'resultado.txt'), 'utf8'), 'Prueba aprobada');
  const snapshot = await call({ type: 'snapshot' });
  assert.ok(
    snapshot.sessions[0].messages.some(
      (m) => m.tool?.tool === 'read_file' && m.tool?.output === 'Referencia externa verificada',
    ),
  );
  assert.equal(snapshot.sessions[0].approvals.length, 0);
  assert.equal(snapshot.sessions[0].stats.costReported, true);
  assert.equal(snapshot.sessions[0].stats.inputTokens, 300);
  assert.ok(!JSON.stringify(snapshot).includes('sk-or-fixture'));
  assert.ok(!(await fs.readFile(path.join(data, 'state.json'), 'utf8')).includes('sk-or-fixture'));
  assert.ok(
    !(await fs.readFile(path.join(data, 'profiles/openrouter-1/api-key.enc'))).includes(
      Buffer.from('sk-or-fixture'),
    ),
  );
  await call({ type: 'stop', sessionId: 's' });
  const g = await call({ type: 'newSession', projectId: 'p', profile: 'gemini-1' });
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="Cuenta del chat"]')?.value === 'gemini-1',
  );
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Hola Gemini');
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Permitir una vez', exact: true }).click();
  await page.getByText('Respuesta Gemini verificada', { exact: true }).waitFor();
  await call({ type: 'stop', sessionId: g.id });
  await app.close();
  app = undefined;
  await launch();
  const restored = await call({ type: 'snapshot' });
  assert.equal(restored.profiles[0].modelSelection.freeOnly, true);
  assert.deepEqual(restored.profiles[0].modelSelection.models, ['test/coder:free']);
  await call({ type: 'accountRefresh', profile: 'gemini-1' });
  assert.equal((await call({ type: 'snapshot' })).accounts['gemini-1'].status, 'signedIn');
  await call({ type: 'accountLogout', profile: 'gemini-1', stopSessions: false });
  assert.equal((await call({ type: 'snapshot' })).accounts['gemini-1'].status, 'signedOut');
  await fs.writeFile(path.join(data, 'profiles/gemini-1/reject-client'), 'fixture');
  await call({ type: 'accountLogin', profile: 'gemini-1', stopSessions: false });
  await until(async () =>
    (await call({ type: 'snapshot' })).accounts['gemini-1'].error?.includes('Google ha retirado'),
  );
  await call({ type: 'accountRefresh', profile: 'gemini-1' });
  assert.equal((await call({ type: 'snapshot' })).accounts['gemini-1'].status, 'unknown');
  await app.close();
  app = undefined;
  await launch();
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page
    .getByRole('button', { name: 'Ver guía oficial de migración a Antigravity', exact: true })
    .waitFor();
  assert.equal((await call({ type: 'snapshot' })).accounts['gemini-1'].status, 'unknown');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: OpenRouter encrypted credentials, catalog/category/free filters and selection, streaming tool approvals, cost/tokens, Google ACP login/chat/approval/logout, persistence, no real accounts or API calls.',
  );
} catch (e) {
  if (page) console.error(await page.locator('body').innerText());
  throw e;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
