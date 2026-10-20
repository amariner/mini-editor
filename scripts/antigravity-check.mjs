// Isolated account and native-chat integration using the public CLI protocol fixture.
import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-agy-ui-')));
const data = path.join(root, 'data'),
  project = path.join(root, 'project'),
  binary = path.join(root, 'agy');
await fs.mkdir(data);
await fs.mkdir(project);
await fs.writeFile(
  binary,
  `#!${process.execPath}
const args=process.argv.slice(2);const send=v=>console.log(JSON.stringify(v));
if(args.includes('models'))console.log('gemini-fixture-low\\tGemini Fixture');
else if(args.includes('/usage'))send({status:'SUCCESS',command:{name:'usage'}});
else if(args.includes('--input-format')){
const input=require('readline').createInterface({input:process.stdin});
input.on('line',line=>{send({event:'init',conversation_id:'fixture'});
if(JSON.parse(line).message.content==='bloqueo'){
send({event:'step_update',step_update:{step_type:'tool',step_index:1,state:'ACTIVE',tool_name:'run_command',tool_info:{parameters:{CommandLine:'ls fixture'},error:{type:'TOOL_ERROR',message:'permission check failed: user denied permission'}}}});
send({event:'result',result:{status:'SUCCESS',conversation_id:'fixture',response:''}});return;
}
send({event:'step_update',step_update:{step_type:'agent_response',state:'ACTIVE',text_delta:'Gemini en Agent Desk'}});send({event:'result',result:{status:'SUCCESS',conversation_id:'fixture',response:'Gemini en Agent Desk',usage:{input_tokens:100,output_tokens:5}}});});input.on('close',()=>process.exit(0));
}else{
if(args.includes('--dangerously-skip-permissions'))process.exit(9);
require('fs').appendFileSync(${JSON.stringify(path.join(root, 'terminal-starts.jsonl'))},JSON.stringify(args)+'\\n');
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h');
let typed='',menu=false,selected=0;
const draw=()=>{
process.stdout.write('\\x1b[2J\\x1b[H');
for(let row=1;row<=process.stdout.rows-2;row++)process.stdout.write('\\x1b['+row+';1H'+(row===1?'Terms of Service & Data Use':row===46?'[x] Optional data collection - fixture only':'Fixture row '+row));
if(menu)process.stdout.write('\\x1b[2J\\x1b[HSelect model\\r\\n'+(selected===0?'> ':'  ')+'Gemini Fixture Flash\\r\\n'+(selected===1?'> ':'  ')+'Gemini Fixture Pro');
process.stdout.write('\\x1b['+process.stdout.rows+';1HModel: '+(selected===0?'Gemini Fixture Flash':'Gemini Fixture Pro'));
};draw();process.on('SIGWINCH',draw);
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',d=>{
require('fs').appendFileSync(${JSON.stringify(path.join(root, 'terminal-input.log'))},d);
const text=d.toString();
if(menu){if(text==='\\x1b[B')selected=1;if(text==='\\r')menu=false;draw();}
else {typed+=text;if(typed.endsWith('/model\\r')){menu=true;typed='';draw();}}
});
setInterval(()=>{},1000);
}
`,
  { mode: 0o700 },
);
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [{ id: 'gemini-1', kind: 'gemini', name: 'Google prueba' }],
    projects: [{ id: 'p', name: 'Prueba', path: project }],
    sessions: [{ id: 's', projectId: 'p', profile: 'gemini-1', title: 'Gemini', messages: [] }],
    selectedProject: 'p',
    selectedSession: 's',
    tools: { gemini: binary },
  }),
);
let app, page;
const launch = async () => {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DATA_DIR: data,
      AGENT_DESK_PROFILES_DIR: '',
      AGENT_DESK_DEV_URL: '',
    },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => console.error('UI:', error.message));
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => !!window.desk);
};
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const wait = async (fn) => {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Timed out');
};
try {
  await launch();
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('button', { name: 'Conectar Google con Antigravity', exact: true }).click();
  await wait(
    async () => (await call({ type: 'snapshot' })).accounts['gemini-1'].status === 'signedIn',
  );
  await page.getByRole('button', { name: 'Cerrar ajustes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('Hola Gemini');
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).press('Enter');
  await page
    .getByRole('tabpanel', { name: 'Gemini', exact: true })
    .getByText('Gemini en Agent Desk', { exact: true })
    .waitFor();
  await wait(async () => (await call({ type: 'snapshot' })).sessions[0].status === 'ready');
  assert.equal((await call({ type: 'snapshot' })).sessions[0].reference, 'agy:fixture');
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).fill('bloqueo');
  await page.getByRole('textbox', { name: 'Mensaje', exact: true }).press('Enter');
  await wait(async () =>
    (await call({ type: 'snapshot' })).sessions[0].messages.some((m) => m.kind === 'warning'),
  );
  await wait(async () => (await call({ type: 'snapshot' })).sessions[0].status === 'ready');
  const blocked = (await call({ type: 'snapshot' })).sessions[0];
  assert.equal(blocked.messages.find((m) => m.role === 'tool').tool.status, 'declined');
  assert.match(blocked.messages.at(-1).text, /continúa.*permiso/);
  assert.doesNotMatch(await page.locator('body').innerText(), /undefined ·/);
  await page.getByRole('button', { name: 'Revisar y continuar', exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/agent-desk-gemini-permission-card.png' });
  await page.getByRole('button', { name: 'Revisar y continuar', exact: true }).click();
  await wait(async () => (await call({ type: 'snapshot' })).sessions[0].status === 'terminal');
  await page.getByRole('region', { name: 'Permisos y ejecución de Gemini', exact: true }).waitFor();
  const startsFile = path.join(root, 'terminal-starts.jsonl');
  await wait(async () => {
    try {
      return (await fs.readFile(startsFile, 'utf8')).trim().length > 0;
    } catch {
      return false;
    }
  });
  const args = JSON.parse((await fs.readFile(startsFile, 'utf8')).trim());
  assert.equal(args[args.indexOf('--conversation') + 1], 'fixture');
  assert.match(args[args.indexOf('--prompt-interactive') + 1], /Continúa.*permisos/);
  await call({ type: 'continueAntigravity', sessionId: 's' });
  assert.equal((await fs.readFile(startsFile, 'utf8')).trim().split('\n').length, 1);
  const current = await call({ type: 'snapshot' });
  assert.equal(current.sessions.length, 1);
  assert.equal(current.terminals.length, 0);
  const viewport = page.getByLabel('Pantalla desplazable de Antigravity', { exact: true });
  const fitsPanel = () =>
    viewport.evaluate((el) => {
      const screen = el.querySelector('.xterm-screen').getBoundingClientRect();
      const view = el.getBoundingClientRect();
      return (
        el.scrollHeight <= el.clientHeight + 1 &&
        screen.bottom <= view.bottom &&
        screen.right <= view.right &&
        screen.height > 30
      );
    });
  await wait(fitsPanel);
  await page.getByRole('button', { name: 'Cambiar modelo', exact: true }).click();
  await page.getByRole('note').filter({ hasText: '/model' }).waitFor();
  await wait(fitsPanel);
  await page.getByRole('button', { name: 'Cambiar modelo', exact: true }).click();
  await page.getByRole('button', { name: 'Leer pantalla larga', exact: true }).click();
  await wait(async () => await viewport.evaluate((el) => el.scrollHeight > el.clientHeight + 100));
  const initialHeight = await viewport.evaluate((el) => el.clientHeight);
  await viewport.hover();
  await page.mouse.wheel(0, 220);
  await wait(async () => await viewport.evaluate((el) => el.scrollTop > 100));
  await page.getByRole('button', { name: 'Final', exact: true }).click();
  assert.ok(
    await viewport.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight) < 2),
  );
  await page.getByRole('button', { name: 'Inicio', exact: true }).click();
  assert.equal(await viewport.evaluate((el) => el.scrollTop), 0);
  await page.getByRole('button', { name: 'Ampliar terminal', exact: true }).click();
  await wait(async () => await viewport.evaluate((el, h) => el.clientHeight > h, initialHeight));
  await page.getByRole('button', { name: 'Reducir terminal', exact: true }).click();
  await wait(async () => await viewport.evaluate((el, h) => el.clientHeight === h, initialHeight));
  assert.ok(
    await page.getByRole('tab', { name: 'Gemini', exact: true }).isVisible(),
    'chat visible before docking',
  );
  // Docking preserves the live xterm, not just the underlying CLI process.
  await page.locator('.terminal-pane .xterm').evaluate((el) => (el.dataset.dockMarker = 'same'));
  await page.getByRole('button', { name: 'Mover terminal a la derecha', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Permisos y ejecución de Gemini', exact: true });
  await wait(async () => {
    const terminal = await panel.boundingBox(),
      chat = await page.locator('.conversation').boundingBox();
    return terminal.x >= chat.x + chat.width && terminal.height > initialHeight;
  });
  assert.ok(
    await page.getByRole('tab', { name: 'Gemini', exact: true }).isVisible(),
    'chat visible after docking',
  );
  assert.equal(
    await page.locator('.terminal-pane .xterm').getAttribute('data-dock-marker'),
    'same',
  );
  assert.equal((await fs.readFile(startsFile, 'utf8')).trim().split('\n').length, 1);
  const separator = page.getByRole('separator', {
    name: 'Ancho del panel de terminal',
    exact: true,
  });
  const widthBefore = (await panel.boundingBox()).width;
  await separator.focus();
  await page.keyboard.press('ArrowLeft');
  await wait(async () => (await panel.boundingBox()).width > widthBefore + 10);
  const padding = await page
    .locator('.terminal-screen')
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  assert.ok(padding >= 16);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '/tmp/agent-desk-terminal-right.png' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 620));
  await wait(async () => (await page.evaluate(() => window.innerWidth)) === 900);
  assert.ok(
    await page.locator('.work-area').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  const close = await page
    .getByRole('button', { name: 'Ocultar panel de terminal', exact: true })
    .boundingBox();
  assert.ok(close.x + close.width <= 900 && close.y + close.height < 620);
  await page.screenshot({ path: '/tmp/agent-desk-terminal-right-small.png' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 850));
  await page.getByRole('button', { name: 'Mover terminal abajo', exact: true }).click();
  await page.getByRole('button', { name: 'Ampliar terminal', exact: true }).waitFor();
  assert.ok(
    await page.getByRole('tab', { name: 'Gemini', exact: true }).isVisible(),
    'chat visible after docking',
  );
  assert.equal(
    await page.locator('.terminal-pane .xterm').getAttribute('data-dock-marker'),
    'same',
  );
  const input = await fs.readFile(path.join(root, 'terminal-input.log'), 'utf8').catch(() => '');
  assert.equal(
    input,
    '',
    'scroll and resize never send acceptance keys or mouse clicks to the CLI',
  );
  await page.getByRole('button', { name: 'Ajustar al panel', exact: true }).click();
  await wait(fitsPanel);
  assert.equal(await viewport.evaluate((el) => el.scrollTop), 0);
  assert.equal(
    await page.locator('.terminal-pane .xterm').getAttribute('data-dock-marker'),
    'same',
  );
  // The user's command and keyboard choice reach the CLI, without injected UI commands.
  await page.locator('.terminal-pane .xterm-helper-textarea').focus();
  await page.keyboard.type('/model');
  await page.keyboard.press('Enter');
  await wait(async () =>
    (await call({ type: 'terminalBuffer', sessionId: 's' })).data.includes('Select model'),
  );
  await wait(async () =>
    (await page.locator('.terminal-pane .xterm').innerText()).includes('Select model'),
  );
  await wait(fitsPanel);
  await page.screenshot({ path: '/tmp/agent-desk-gemini-model-selector.png' });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await wait(async () =>
    (await call({ type: 'terminalBuffer', sessionId: 's' })).data.endsWith(
      'Model: Gemini Fixture Pro',
    ),
  );
  assert.equal(
    await fs.readFile(path.join(root, 'terminal-input.log'), 'utf8'),
    '/model\r\x1b[B\r',
  );
  await wait(async () =>
    (await page.locator('.terminal-pane .xterm').innerText()).includes('Model: Gemini Fixture Pro'),
  );
  await page.screenshot({ path: '/tmp/agent-desk-gemini-permission-panel.png' });
  await page.getByRole('button', { name: 'Ocultar panel de terminal', exact: true }).click();
  assert.equal((await call({ type: 'snapshot' })).sessions[0].status, 'terminal');
  await page.getByRole('button', { name: 'Mostrar panel de Gemini', exact: true }).click();
  await page.getByRole('button', { name: 'Detener y volver al chat', exact: true }).click();
  await wait(async () => (await call({ type: 'snapshot' })).sessions[0].mode === 'chat');
  assert.equal(
    await page.getByRole('button', { name: 'Revisar y continuar', exact: true }).count(),
    0,
  );
  await app.close();
  app = undefined;
  await launch();
  await wait(async () => !(await call({ type: 'snapshot' })).accounts['gemini-1'].busy);
  await call({ type: 'accountRefresh', profile: 'gemini-1' });
  assert.equal((await call({ type: 'snapshot' })).accounts['gemini-1'].status, 'signedIn');
  await call({ type: 'accountLogout', profile: 'gemini-1', stopSessions: false });
  assert.equal((await call({ type: 'snapshot' })).accounts['gemini-1'].status, 'signedOut');
  console.log(
    'PASS: Antigravity connection, native Gemini chat, same-conversation terminal permissions, restart persistence, local unlink.',
  );
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      await page.locator('.terminal-screen-viewport').evaluateAll((nodes) =>
        nodes.map((el) => ({
          viewport: el.getBoundingClientRect().toJSON(),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          screen: el.querySelector('.xterm-screen')?.getBoundingClientRect().toJSON(),
          host: el.querySelector('.terminal-host')?.getBoundingClientRect().toJSON(),
        })),
      ),
    );
    await page.screenshot({ path: '/tmp/agent-desk-gemini-test-failure.png' });
    console.error((await page.locator('body').innerText()).slice(-2500));
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
