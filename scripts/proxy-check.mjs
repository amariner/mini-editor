// Isolated UI/proxy regression. No real credentials or model requests.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-proxy-')));
const data = path.join(root, 'data');
await fs.mkdir(data);
const claude = path.join(root, 'claude');
const codex = path.join(root, 'codex');
await fs.writeFile(claude, `#!${process.execPath}\nconsole.log('{"loggedIn":false}');\n`, {
  mode: 0o700,
});
await fs.writeFile(
  codex,
  `#!${process.execPath}
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.id!==undefined) console.log(JSON.stringify({id:m.id,result:m.method==='account/read'?{account:null}:{}}));
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
    projects: [],
    sessions: [],
    tools: { claude, codex },
  }),
);
const proxy = http.createServer();
let connections = 0;
proxy.on('connect', (req, socket) => {
  connections++;
  socket.end(
    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Fixture"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
  );
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;
let app;
const launch = async () => {
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
  await page.waitForFunction(() => !!window.desk);
  await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
  await page.getByRole('tab', { name: 'Red', exact: true }).click();
  return page;
};
try {
  let page = await launch();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('combobox', { name: 'Modo de proxy' }).selectOption('manual');
  await page.getByRole('textbox', { name: 'Servidor del proxy' }).fill('127.0.0.1');
  await page.getByRole('spinbutton', { name: 'Puerto del proxy' }).fill(String(port));
  await page.getByRole('button', { name: 'Probar ChatGPT', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '407' }).waitFor();
  assert.equal(connections, 1);
  await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Configuración guardada' }).waitFor();
  const saved = JSON.parse(await fs.readFile(path.join(data, 'network.json'), 'utf8'));
  assert.equal(saved.host, '127.0.0.1');
  assert.equal(saved.port, port);
  assert.equal(saved.encryptedPassword, undefined);
  const resolved = await app.evaluate(async ({ session }) =>
    session.defaultSession.resolveProxy('https://example.com'),
  );
  assert.equal(resolved, `PROXY 127.0.0.1:${port}`);
  const local = await app.evaluate(async ({ session }) =>
    session.defaultSession.resolveProxy('http://localhost:3000'),
  );
  assert.equal(local, 'DIRECT');
  await fs.mkdir('artifacts', { recursive: true });
  await page.locator('.account-settings').evaluate((el) => { el.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/proxy-settings.png' });
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  page = await launch();
  assert.equal(
    await page.getByRole('textbox', { name: 'Servidor del proxy' }).inputValue(),
    '127.0.0.1',
  );
  assert.equal(
    await page.getByRole('spinbutton', { name: 'Puerto del proxy' }).inputValue(),
    String(port),
  );
  assert.equal(await page.getByRole('combobox', { name: 'Modo de proxy' }).inputValue(), 'manual');
  await page.getByRole('combobox', { name: 'Modo de proxy' }).selectOption('system');
  await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Configuración guardada' }).waitFor();
  assert.equal(
    JSON.parse(await fs.readFile(path.join(data, 'network.json'), 'utf8')).mode,
    'system',
  );
  console.log(
    'Proxy UI: 407, save, browser routing, localhost bypass and restart persistence passed.',
  );
} finally {
  if (app) await app.close();
  await new Promise((resolve) => proxy.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
