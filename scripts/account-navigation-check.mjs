// Isolated navigation/network regression: fake CLIs, no real credentials or model calls.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'desk-account-navigation-')),
);
const data = path.join(root, 'data');
const project = path.join(root, 'project');
const log = path.join(root, 'calls.jsonl');
const failure = path.join(root, 'offline');
const codex = path.join(root, 'codex');
const claude = path.join(root, 'claude');
await fs.mkdir(data);
await fs.mkdir(project);
await fs.writeFile(
  claude,
  `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:false}));\n`,
  { mode: 0o700 },
);
await fs.writeFile(
  codex,
  `#!${process.execPath}
const fs = require('fs');
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.id === undefined) return;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({method:m.method})+'\\n');
  let result = {};
  let error;
  if(m.method==='account/read') {
    if(fs.existsSync(${JSON.stringify(failure)})) error={code:-32603,message:'workspace routing discovery failed'};
    else result={account:{type:'chatgpt',email:'fixture@example.com',planType:'plus'}};
  }
  if(m.method==='account/rateLimits/read') error={code:-32603,message:'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)'};
  if(m.method==='model/list') result={data:[],nextCursor:null};
  if(m.method==='thread/start') result={thread:{id:'fixture-thread',turns:[]}};
  if(m.method==='turn/start') result={turn:{id:'fixture-turn',status:'inProgress'}};
  console.log(JSON.stringify({id:m.id,...(error?{error}:{result})}));
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
    projects: [{ id: 'p', name: 'Proyecto', path: project }],
    sessions: [{ id: 'c1', projectId: 'p', profile: 'claude-1', title: 'Sesión 1', messages: [] }],
    selectedProject: 'p',
    selectedSession: 'c1',
    tools: { claude, codex },
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
  const snapshot = () => call({ type: 'snapshot' });
  const poll = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = await snapshot();
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Fixture state not reached');
  };
  const settle = () => poll((s) => Object.values(s.accounts).every((a) => !a.busy));
  await poll((s) => s.accounts.codex.status === 'signedIn');
  await settle();
  const calls = async (method) =>
    (await fs.readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((x) => x.method === method).length;
  const initialReads = await calls('account/read');
  const selector = page.getByRole('combobox', { name: 'Cuenta del chat' });
  const uiReady = async (profile) => {
    await page.waitForFunction((profile) => {
      const el = document.querySelector('[aria-label="Cuenta del chat"]');
      return el?.value === profile && !el.disabled;
    }, profile);
  };
  const switchAccount = async (profile) => {
    await selector.selectOption(profile);
    await uiReady(profile);
  };
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
  await uiReady('claude-1');
  const claudeSession = (await snapshot()).selectedSession;
  await page.locator('.composer textarea').fill('Borrador Claude');
  await switchAccount('codex');
  await settle();
  await poll((s) => !!s.accounts.codex.usage);
  assert.equal((await snapshot()).accounts.codex.status, 'signedIn');
  assert.equal((await snapshot()).accounts.codex.error, undefined);
  assert.match((await snapshot()).accounts.codex.usage.unavailable, /conectar con ChatGPT/);
  assert.equal(
    await calls('account/read'),
    initialReads,
    'polling does not revalidate authentication',
  );
  const codexSession = (await snapshot()).selectedSession;
  for (let i = 0; i < 3; i++) {
    await switchAccount('claude-1');
    assert.equal((await snapshot()).selectedSession, claudeSession);
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Borrador Claude');
    await switchAccount('codex');
    assert.equal((await snapshot()).selectedSession, codexSession);
    assert.equal(await page.locator('.composer textarea').inputValue(), 'Borrador Claude');
  }
  assert.equal(
    await calls('account/rateLimits/read'),
    1,
    'account switching is throttled, including failures',
  );
  assert.equal((await snapshot()).sessions.length, 2, 'changing the account does not create a tab');
  assert.equal(codexSession, claudeSession);
  assert.equal(await page.locator('.topbar .usage-switcher').count(), 0);
  assert.equal(await page.locator('.composer-footer .usage-switcher').count(), 1);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('radio', { name: 'Usar ChatGPT como cuenta predeterminada' }).click();
  await poll((s) => s.defaultProfile === 'codex');
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Nueva conversación', exact: true }).click();
  await uiReady('codex');
  const defaultSession = (await snapshot()).selectedSession;
  assert.notEqual(defaultSession, codexSession);
  assert.equal(await page.locator('.composer textarea').inputValue(), '');
  assert.equal((await snapshot()).sessions.find((s) => s.id === 'c1').profile, 'claude-1');
  await page.getByRole('tab', { name: 'Sesión 2', exact: true }).click();
  await uiReady('codex');
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Borrador Claude');
  await fs.writeFile(failure, 'offline');
  await assert.rejects(call({ type: 'start', sessionId: codexSession }), /conectar con ChatGPT/);
  await settle();
  let session = (await snapshot()).sessions.find((s) => s.id === codexSession);
  assert.equal(session.status, 'error', 'failed auth verification does not leave a ready agent');
  assert.match(session.error, /conectar con ChatGPT/, 'cleanup preserves the original error');
  assert.equal(await page.getByText('Conecta tu cuenta de ChatGPT', { exact: true }).count(), 0);
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Borrador Claude');
  await assert.rejects(call({ type: 'accountRefresh', profile: 'codex' }), /conectar con ChatGPT/);
  assert.equal((await snapshot()).accounts.codex.status, 'unknown');
  await call({ type: 'refreshUsage', profile: 'codex' });
  assert.match(
    (await snapshot()).accounts.codex.error,
    /conectar con ChatGPT/,
    'background polling does not clear verification error',
  );
  await fs.rm(failure);
  await call({ type: 'accountRefresh', profile: 'codex' });
  await call({ type: 'start', sessionId: codexSession });
  session = (await snapshot()).sessions.find((s) => s.id === codexSession);
  assert.equal(session.status, 'ready', 'retry recovers after connection returns');
  assert.equal((await snapshot()).accounts.codex.status, 'signedIn');
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await poll((s) => s.sessions.find((x) => x.id === codexSession).accountLocked);
  await page.locator('.usage-switcher.locked').waitFor();
  await page.waitForFunction(() => document.querySelector('.composer textarea')?.value === '');
  await assert.rejects(
    call({ type: 'changeSessionAccount', sessionId: codexSession, profile: 'claude-1' }),
    /Abre otra pestaña/,
  );
  await call({ type: 'stop', sessionId: codexSession });
  await assert.rejects(
    call({ type: 'changeSessionAccount', sessionId: codexSession, profile: 'claude-1' }),
    /Abre otra pestaña/,
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.locator('.activity-dock').waitFor({ state: 'hidden' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'artifacts/cuenta-por-chat.png' });
  await page.setViewportSize({ width: 900, height: 620 });
  const footer = await page.locator('.composer-footer').boundingBox();
  const switcher = await page.locator('.usage-switcher').boundingBox();
  assert.ok(switcher.x >= footer.x && switcher.x + switcher.width <= footer.x + footer.width);
  assert.deepEqual(errors, []);
  await app.close();
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  const reopened = await app.firstWindow();
  await reopened.waitForFunction(() => !!window.desk);
  const persisted = await reopened.evaluate(() => window.desk.invoke({ type: 'snapshot' }));
  assert.equal(persisted.defaultProfile, 'codex');
  assert.equal(persisted.sessions.find((s) => s.id === codexSession).accountLocked, true);
  await assert.rejects(
    reopened.evaluate(
      (id) =>
        window.desk.invoke({ type: 'changeSessionAccount', sessionId: id, profile: 'claude-1' }),
      codexSession,
    ),
    /Abre otra pestaña/,
  );
  console.log(
    'PASS: per-chat account switching preserves drafts, default applies only to new tabs, mixed-provider tabs coexist, first send locks durably, network errors recover, layout fits compact windows.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
