// Isolated CLI fixture; never authenticates or requests inference from Freebuff.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-freebuff-')));
const data = path.join(root, 'data'),
  project = path.join(root, 'project'),
  other = path.join(root, 'other');
for (const dir of [data, project, other]) await fs.mkdir(dir);
const binary = path.join(root, 'freebuff');
const starts = path.join(root, 'starts.jsonl');
await fs.writeFile(
  binary,
  `#!${process.execPath}
const fs=require('fs');
fs.appendFileSync(${JSON.stringify(starts)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd(),inheritedKey:!!process.env.FREEBUFF_API_KEY,home:process.env.HOME===${JSON.stringify(process.env.HOME)}})+'\\n');
process.stdout.write('Freebuff fixture: sign in and pick models here.\\r\\n');
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',d=>{if(d.toString()==='q')process.exit(0);else process.stdout.write('Typed: '+d.toString()+'\\r\\n');});
setInterval(()=>{},1000);
`,
  { mode: 0o700 },
);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [],
    projects: [
      { id: 'p', name: 'Freebuff prueba', path: project },
      { id: 'q', name: 'Otro proyecto', path: other },
    ],
    sessions: [],
    selectedProject: 'p',
    tools: { freebuff: binary },
  }),
);
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const wait = async (fn) => {
  for (let i = 0; i < 120; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('timeout');
};
const records = async () =>
  (await fs.readFile(starts, 'utf8'))
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
      FREEBUFF_API_KEY: 'fixture-must-not-inherit',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  assert.equal((await call({ type: 'snapshot' })).tools.freebuff, binary);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir Freebuff en este proyecto', exact: true }).click();
  await page.getByRole('region', { name: 'Terminal oficial de Freebuff', exact: true }).waitFor();
  await wait(async () =>
    (await call({ type: 'terminalBuffer', sessionId: 'freebuff:p' })).data.includes(
      'Freebuff fixture',
    ),
  );
  const first = (await records())[0];
  assert.equal(first.cwd, project);
  assert.deepEqual(first.args, []);
  assert.equal(first.inheritedKey, false);
  assert.equal(first.home, true);
  assert.equal((await call({ type: 'snapshot' })).profiles.length, 0, 'no fake native account');
  assert.equal((await call({ type: 'snapshot' })).sessions.length, 0, 'no hidden prompts/chats');
  await page.getByRole('button', { name: 'Mover terminal a la derecha', exact: true }).click();
  await call({ type: 'openFreebuff', projectId: 'p' });
  assert.equal((await records()).length, 1, 'opening is idempotent');
  await page.locator('.terminal-pane .xterm-helper-textarea').focus();
  await page.keyboard.type('human-input');
  await wait(async () =>
    (await call({ type: 'terminalBuffer', sessionId: 'freebuff:p' })).data.includes('Typed:'),
  );
  await page.getByRole('button', { name: 'Consola', exact: true }).click();
  await wait(async () =>
    (await call({ type: 'snapshot' })).terminals.some((t) => t.id === 'shell:p'),
  );
  assert.equal(
    (await call({ type: 'snapshot' })).terminals.filter((t) => t.status === 'terminal').length,
    2,
  );
  await page.getByRole('button', { name: 'Freebuff', exact: true }).click();
  assert.equal((await records()).length, 1);
  await page.getByRole('button', { name: 'Ocultar panel de terminal', exact: true }).click();
  assert.equal(
    (await call({ type: 'snapshot' })).terminals.find((t) => t.id === 'freebuff:p').status,
    'terminal',
  );
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Detener Freebuff', exact: true }).click();
  await wait(
    async () =>
      (await call({ type: 'snapshot' })).terminals.find((t) => t.id === 'freebuff:p').status ===
      'stopped',
  );
  assert.equal(
    (await call({ type: 'snapshot' })).terminals.find((t) => t.id === 'shell:p').status,
    'terminal',
  );
  assert.throws(() => process.kill(first.pid, 0));
  await page.getByRole('button', { name: 'Abrir Freebuff', exact: true }).click();
  await wait(async () => (await records()).length === 2);
  await call({ type: 'openFreebuff', projectId: 'q' });
  await wait(async () => (await records()).length === 3);
  assert.equal((await records())[2].cwd, other);
  await page.screenshot({ path: '/tmp/agent-desk-freebuff.png' });
  await call({ type: 'removeProject', projectId: 'p' });
  assert.ok((await call({ type: 'snapshot' })).terminals.every((t) => t.projectId !== 'p'));
  assert.equal(
    (await call({ type: 'snapshot' })).terminals.find((t) => t.id === 'freebuff:q').status,
    'terminal',
  );
  const last = (await records()).at(-1).pid;
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Quitar Freebuff', exact: true }).click();
  await wait(async () => !(await call({ type: 'snapshot' })).freebuffEnabled);
  await wait(
    async () => !(await call({ type: 'snapshot' })).terminals.some((t) => t.kind === 'freebuff'),
  );
  assert.throws(() => process.kill(last, 0));
  assert.equal(await page.getByRole('region', { name: 'Freebuff CLI', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Freebuff', exact: true }).count(), 0);
  await assert.rejects(call({ type: 'openFreebuff', projectId: 'q' }), /Añade Freebuff/);
  await app.close();
  app = undefined;
  assert.throws(() => process.kill(last, 0));
  const saved = JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'));
  assert.equal(saved.tools.freebuff, binary);
  assert.equal(saved.freebuffEnabled, false);
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  assert.equal((await call({ type: 'snapshot' })).freebuffEnabled, false);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Quitar Freebuff', exact: true }).count(), 0);
  await page
    .getByRole('dialog', { name: 'Ajustes', exact: true })
    .getByRole('button', { name: 'Añadir cuenta', exact: true })
    .click();
  await page.getByLabel('Proveedor de la nueva cuenta').selectOption('freebuff');
  await page.getByRole('button', { name: 'Añadir Freebuff', exact: true }).click();
  await page.getByRole('button', { name: 'Quitar Freebuff', exact: true }).waitFor();
  assert.equal((await call({ type: 'snapshot' })).freebuffEnabled, true);
  assert.equal((await call({ type: 'snapshot' })).profiles.length, 0);
  await app.close();
  app = undefined;
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Freebuff official CLI launcher, manual input, shared local identity, no prompts/API keys, per-project processes, shell coexistence, dock/hide, stop/reopen, project removal and app shutdown.',
  );
} catch (e) {
  if (page && !page.isClosed())
    await page.screenshot({ path: '/tmp/agent-desk-freebuff-failure.png' });
  throw e;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
