// Real Electron/IPC with an isolated app-server fixture. No accounts or model calls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-codex-permissions-')));
const data = path.join(root, 'data'),
  project = path.join(root, 'project');
await Promise.all([data, project].map((dir) => fs.mkdir(dir)));
const log = path.join(root, 'rpc.jsonl'),
  cli = path.join(root, 'provider');
await fs.writeFile(
  cli,
  `#!${process.execPath}
const fs=require('fs');
const emit=m=>console.log(JSON.stringify(m));
let turn=0;
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');
 if(m.method){
  if(m.id===undefined)return;
  let result={};
  if(m.method==='account/read')result={account:{type:'chatgpt',email:'fixture@example.test'}};
  if(m.method==='model/list')result={data:[{model:'fixture',displayName:'Codex Fixture',isDefault:true}]};
  if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'thread',turns:[]}};
  if(m.method==='turn/start')result={turn:{id:'turn-'+(++turn),status:'inProgress'}};
  emit({id:m.id,result});
  if(m.method==='turn/start'){
   emit({method:'turn/started',params:{threadId:'thread',turn:{id:'turn-'+turn}}});
   if(turn<=2)emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn-'+turn,status:'completed'}}});
   else emit({id:800+turn,method:turn===3?'item/commandExecution/requestApproval':'item/permissions/requestApproval',params:{threadId:'thread',turnId:'turn-'+turn,itemId:'item-'+turn,reason:'Acceso solicitado para la prueba',...(turn===3?{command:'fixture-command',cwd:${JSON.stringify(project)},availableDecisions:['acceptForSession','cancel']}:{permissions:{network:{enabled:true},fileSystem:{write:[${JSON.stringify(root)}]}}})}});
  }
 }else if(m.id>=803){
  emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn-'+turn,status:'completed'}}});
 }
});
`,
  { mode: 0o700 },
);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [{ id: 'codex', kind: 'codex', name: 'ChatGPT' }],
    defaultProfile: 'codex',
    projects: [{ id: 'p', name: 'Permisos', path: project }],
    sessions: [
      { id: 's', projectId: 'p', profile: 'codex', mode: 'chat', title: 'Permisos', messages: [] },
    ],
    selectedProject: 'p',
    selectedSession: 's',
    tools: { codex: cli },
  }),
);
let app;
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  const call = (action) => page.evaluate((a) => window.desk.invoke(a), action);
  const state = () => call({ type: 'snapshot' });
  async function poll(condition) {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const snapshot = await state();
      if (condition(snapshot.sessions[0])) return snapshot.sessions[0];
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Fixture condition timed out');
  }
  await poll((s) => s.info?.models.length);
  const menu = page.getByRole('button', { name: 'Permisos de Codex', exact: true });
  await menu.click();
  assert.equal(await page.locator('.popover button small').count(), 4);
  assert.equal(await page.getByRole('button', { name: 'Nunca', exact: true }).count(), 0);
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/codex-permisos-menu.png' });
  await page.getByRole('button', { name: /^Acceso total Puede escribir/ }).click();
  await poll((s) => s.codexConfig?.sandbox === 'danger-full-access');
  assert.match(await menu.innerText(), /Acceso total/);
  await call({ type: 'start', sessionId: 's' });
  await call({ type: 'send', sessionId: 's', text: 'Primera tarea' });
  await poll((s) => s.status === 'ready');
  await menu.click();
  await page.getByRole('button', { name: /^Solo lectura Consulta/ }).click();
  await poll((s) => s.codexConfig?.sandbox === 'read-only');
  await call({ type: 'send', sessionId: 's', text: 'Segunda tarea' });
  await poll((s) => s.status === 'ready');
  let requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const turns = requests.filter((m) => m.method === 'turn/start');
  assert.deepEqual(turns[0].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(turns[0].params.approvalPolicy, 'never');
  assert.deepEqual(turns[1].params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(turns[1].params.approvalPolicy, 'untrusted');
  assert.equal(requests.filter((m) => m.method === 'thread/start').length, 1);
  await call({ type: 'send', sessionId: 's', text: 'Solicita permiso para un comando' });
  await poll((s) => s.approvals.length === 1);
  const approval = page.getByRole('region', { name: 'Solicitud de Codex' });
  assert.equal(await approval.getByRole('button', { name: /Permitir una vez/ }).count(), 0);
  await approval.getByRole('button', { name: /Permitir durante este chat/ }).click();
  await poll((s) => s.status === 'ready');
  requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.find((m) => m.id === 803 && m.result).result, {
    decision: 'acceptForSession',
  });
  await call({ type: 'send', sessionId: 's', text: 'Solicita acceso adicional' });
  await poll((s) => s.approvals.length === 1);
  await menu.click();
  await page.getByRole('button', { name: /^Trabajar en el proyecto Edita/ }).click();
  await poll((s) => s.notice?.includes('siguiente mensaje'));
  assert.match(
    await page.locator('.composer-area [role="status"]').innerText(),
    /siguiente mensaje/,
  );
  await page.screenshot({ path: 'artifacts/codex-permisos-solicitud.png' });
  await approval.getByRole('button', { name: /Permitir durante esta tarea/ }).click();
  await poll((s) => s.status === 'ready');
  requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.find((m) => m.id === 804 && m.result).result, {
    permissions: { network: { enabled: true }, fileSystem: { write: [root] } },
    scope: 'turn',
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Electron UI/IPC, access and revocation on one loaded thread, session approval, limited turn grant, and active-turn timing. Isolated protocol fixture; no model calls.',
  );
} finally {
  if (app) await app.close();
  await fs.rm(root, { recursive: true, force: true });
}
