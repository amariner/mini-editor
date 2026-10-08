// Real Electron and Claude SDK, isolated fake provider processes; no model calls or real accounts.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-prechat-project-')));
const data = path.join(root, 'data'),
  project = path.join(root, 'project'),
  keep = path.join(root, 'keep');
await Promise.all([data, project, keep].map((dir) => fs.mkdir(dir)));
const log = path.join(root, 'requests.jsonl'),
  cli = path.join(root, 'provider');
await fs.writeFile(path.join(project, 'source.txt'), 'source stays');
await fs.writeFile(
  cli,
  `#!${process.execPath}
const fs=require('fs');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,start:true})+'\\n');
if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:false}));process.exit(0);}
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,method:m.method,type:m.type,subtype:m.request?.subtype,mode:m.request?.mode,canBypass:process.argv.includes('--allow-dangerously-skip-permissions')})+'\\n');
 if(m.type==='control_request'){
  if(fs.existsSync(${JSON.stringify(path.join(root, 'hang-initialization'))}))return;
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:[{value:'fixture-claude',displayName:'Claude Fixture',description:'',supportedEffortLevels:['low','high']}],commands:[],agents:[],account:{},mcpServers:[{name:"agent_desk",status:"connected",tools:[]}]}}}));
 }else if(m.id!==undefined){
  let result={};
  if(m.method==='account/read')result={account:{type:'chatgpt',email:'fixture@example.test'}};
  if(m.method==='model/list')result={data:[{model:'fixture-codex',displayName:'Codex Fixture',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]};
  if(m.method==='thread/start')result={thread:{id:'fixture-thread',turns:[]}};
  if(m.method==='turn/start')result={turn:{id:'fixture-turn',status:'inProgress'}};
  console.log(JSON.stringify({id:m.id,result}));
 }
});
`,
  { mode: 0o700 },
);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [
      { id: 'claude-1', kind: 'claude', name: 'Personal' },
      { id: 'codex', kind: 'codex', name: 'ChatGPT' },
    ],
    defaultProfile: 'claude-1',
    projects: [
      { id: 'p', name: 'Eliminar', path: project },
      { id: 'keep', name: 'Conservar', path: keep },
    ],
    sessions: [
      {
        id: 'c1',
        projectId: 'p',
        profile: 'claude-1',
        mode: 'chat',
        title: 'Nuevo',
        messages: [],
        accountLocked: false,
      },
    ],
    selectedProject: 'p',
    selectedSession: 'c1',
    tools: { claude: cli, codex: cli },
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
  await page.emulateMedia({ colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
  const state = () => call({ type: 'snapshot' });
  const poll = async (fn) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const s = await state();
      if (fn(s)) return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Fixture condition timed out');
  };
  await poll((s) => s.sessions[0].info?.models.length);
  await page.getByRole('button', { name: 'Modelo', exact: true }).click();
  await page.getByRole('button', { name: 'Claude Fixture', exact: true }).click();
  await poll((s) => s.sessions[0].config?.model === 'fixture-claude');
  assert.equal((await state()).sessions[0].status, 'stopped');
  await call({ type: 'start', sessionId: 'c1' });
  await page
    .getByRole('button', { name: 'Modo de permisos (⇧⇥ para alternar)', exact: true })
    .click();
  assert.equal(await page.getByRole('button', { name: 'No preguntar', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Omitir permisos', exact: true }).click();
  await poll((s) => s.sessions[0].info?.permissionMode === 'bypassPermissions');
  assert.equal((await state()).sessions[0].notice, undefined);
  const changes = (await fs.readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((r) => r.subtype === 'set_permission_mode');
  assert.equal(changes.at(-1).mode, 'bypassPermissions');
  assert.equal(changes.at(-1).canBypass, true);
  await page
    .getByRole('button', { name: 'Modo de permisos (⇧⇥ para alternar)', exact: true })
    .click();
  await page.getByRole('button', { name: 'Preguntar', exact: true }).click();
  await poll((s) => s.sessions[0].info?.permissionMode === 'default');
  await page.getByRole('combobox', { name: 'Cuenta del chat' }).selectOption('codex');
  await poll((s) => s.sessions[0].profile === 'codex' && s.sessions[0].info?.models.length);
  await page.getByRole('button', { name: 'Modelo de Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Codex Fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Esfuerzo de razonamiento', exact: true }).click();
  await page.getByRole('button', { name: 'high', exact: true }).click();
  await poll((s) => s.sessions[0].codexConfig?.effort === 'high');
  let s = (await state()).sessions[0];
  assert.equal(s.accountLocked, false);
  assert.equal(s.messages.length, 0);
  assert.equal(s.status, 'stopped');
  const requests = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(
    !requests.some(
      (r) => r.method === 'thread/start' || r.method === 'turn/start' || r.type === 'user',
    ),
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.getByRole('button', { name: 'Modelo de Codex', exact: true }).click();
  await page.screenshot({ path: 'artifacts/modelos-antes-del-chat.png' });
  await page.getByRole('button', { name: 'Modelo de Codex', exact: true }).click();
  await call({ type: 'start', sessionId: s.id });
  await call({ type: 'send', sessionId: s.id, text: 'Fixture turn' });
  const second = await call({ type: 'newSession', projectId: 'p', profile: 'codex' });
  await call({ type: 'start', sessionId: second.id });
  await fs.writeFile(path.join(root, 'hang-initialization'), 'hang');
  const pending = await call({ type: 'newSession', projectId: 'p', profile: 'claude-1' });
  const starting = call({ type: 'start', sessionId: pending.id }).then(
    () => 'started',
    () => 'cancelled',
  );
  await poll((state) => state.sessions.find((s) => s.id === pending.id)?.status === 'starting');
  await call({ type: 'openProjectTerminal', projectId: 'p' });
  await call({ type: 'browserNew', projectId: 'p', sessionId: second.id });
  await app.evaluate(async ({ session }) => {
    await session
      .fromPartition('desk-browser-p')
      .cookies.set({ url: 'https://fixture.test', name: 'cached', value: 'value' });
    await session
      .fromPartition('desk-browser-keep')
      .cookies.set({ url: 'https://fixture.test', name: 'keep', value: 'value' });
  });
  // A valid PNG attachment is removed along with its original bytes.
  const png = await app.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(Buffer.alloc(16, 255), { width: 2, height: 2 })
      .toPNG()
      .toString('base64'),
  );
  const images = await call({
    type: 'dropImages',
    sessionId: second.id,
    images: [
      {
        name: 'pixel.png',
        data: png,
      },
    ],
  });
  assert.equal(images.length, 1);
  const expand = page.getByRole('button', { name: 'Expandir proyectos', exact: true });
  if (await expand.count()) await expand.click();
  await page.getByRole('button', { name: 'Eliminar', exact: true }).hover();
  await page.getByRole('button', { name: 'Quitar Eliminar', exact: true }).click();
  await page.getByRole('button', { name: 'Quitar proyecto y chats', exact: true }).click();
  const after = await poll((s) => !s.projects.some((p) => p.id === 'p'));
  assert.equal(await starting, 'cancelled');
  assert.ok(after.sessions.every((s) => s.projectId !== 'p'));
  assert.ok(after.browsers.every((b) => b.projectId !== 'p'));
  assert.ok(after.terminals.every((t) => t.projectId !== 'p'));
  assert.deepEqual(await fs.readdir(path.join(data, 'attachments')), []);
  assert.equal(await fs.readFile(path.join(project, 'source.txt'), 'utf8'), 'source stays');
  const cookies = await app.evaluate(async ({ session }) => ({
    removed: await session.fromPartition('desk-browser-p').cookies.get({}),
    keep: await session.fromPartition('desk-browser-keep').cookies.get({}),
  }));
  assert.equal(cookies.removed.length, 0);
  assert.equal(cookies.keep.length, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
  assert.ok(persisted.sessions.every((s) => s.projectId !== 'p'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: models/effort before first message, unlocked account, SDK query without inference, active project removal, browser/attachment/terminal cleanup and isolation.',
  );
} finally {
  if (app) await app.close();
  await fs.rm(root, { recursive: true, force: true });
}
