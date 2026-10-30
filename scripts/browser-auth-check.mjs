// Local synthetic authentication only. No user cookies/accounts or external browser launches.
import { _electron as electron } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-browser-auth-')));
const data = path.join(root, 'data'),
  project = path.join(root, 'project');
await fs.mkdir(data);
await fs.mkdir(project);
const requests = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, method: req.method, body, cookie: req.headers.cookie ?? '' });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/app') {
    res.setHeader('Set-Cookie', [
      'fixture-persistent=yes; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',
      'fixture-pkce=test; Path=/; HttpOnly; SameSite=Lax',
      'fixture-partitioned=private; Path=/; HttpOnly; Secure; SameSite=None; Partitioned',
    ]);
    res.end(`<!doctype html><title>Acceso de prueba</title><h1>Acceso de prueba</h1>
      <script>localStorage.setItem('fixture','saved'); sessionStorage.setItem('fixture','copied');
      addEventListener('message',event=>{if(event.origin===location.origin)document.querySelector('#result').textContent=event.data;});</script>
      <button onclick="window.child=window.open('/authorize','auth','width=600,height=700')">Autorizar</button>
      <button onclick="const child=window.open('about:blank','blank'); child.location='/blank-callback'">Ventana en blanco</button>
      <form action="/post-callback" method="post" target="post"><input name="state" value="test-state"><button>Enviar formulario</button></form>
      <button onclick="window.open('file:///etc/passwd')">Esquema bloqueado</button><p id="result">Pendiente</p>`);
  } else if (req.url === '/authorize') {
    res.end(`<!doctype html><title>Autorizar</title><h1>Autorizar</h1><p id="state"></p>
      <script>document.querySelector('#state').textContent='opener:'+!!window.opener+' storage:'+sessionStorage.getItem('fixture');</script>
      <button onclick="window.opener.postMessage('Autorizado',location.origin); window.close()">Aceptar</button>`);
  } else {
    res.end(`<!doctype html><title>Comprobación</title><h1>${req.url}</h1><p id="state"></p><script>
      document.querySelector('#state').textContent='persistent:${(req.headers.cookie ?? '').includes('fixture-persistent=yes')} pkce:${(req.headers.cookie ?? '').includes('fixture-pkce=test')} local:'+localStorage.getItem('fixture')+' opener:'+!!window.opener;
      </script><button onclick="window.close()">Cerrar</button>`);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [{ id: 'claude-1', kind: 'claude', name: 'Test' }],
    projects: [
      { id: 'p', name: 'Proyecto acceso', path: project },
      { id: 'q', name: 'Proyecto aislado', path: project },
    ],
    sessions: [{ id: 's', projectId: 'p', profile: 'claude-1', title: 'Prueba', messages: [] }],
    selectedProject: 'p',
    selectedSession: 's',
    tools: { claude: '/usr/bin/false', codex: '/usr/bin/false' },
  }),
);
let app, page;
const errors = [];
const call = (action) => page.evaluate((a) => window.desk.invoke(a), action);
const snapshot = () => call({ type: 'snapshot' });
const act = (tabId, input) => call({ type: 'browserTab', tabId, input });
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Estado de autenticación no alcanzado');
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
  app.process().stderr.on('data', (data) => {
    if (String(data).includes('Error')) process.stderr.write(data);
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
}
async function click(tabId, label) {
  const info = await act(tabId, { action: 'inspect' });
  await act(tabId, { action: 'click', ref: info.elements.find((e) => e.label === label).ref });
}
try {
  await launch();
  const parent = await call({
    type: 'browserNew',
    projectId: 'p',
    sessionId: 's',
    url: origin + '/app',
  });
  await click(parent.id, 'Autorizar');
  const popup = await until(async () =>
    (await snapshot()).browsers.find((b) => b.url === origin + '/authorize' && !b.loading),
  );
  assert.match((await act(popup.id, { action: 'inspect' })).text, /opener:true storage:copied/);
  assert.ok(requests.find((r) => r.path === '/authorize').cookie.includes('fixture-pkce=test'));
  const privileges = await app.evaluate(async ({ webContents }, url) => {
    const guest = webContents.getAllWebContents().find((w) => w.getURL() === url);
    return guest.executeJavaScript('({require:typeof require,desk:typeof window.desk})');
  }, origin + '/authorize');
  assert.deepEqual(privileges, { require: 'undefined', desk: 'undefined' });
  // Explicit external opening goes through the known tab; stub only native launch functions.
  await app.evaluate(({ shell }) => {
    const cp = process.getBuiltinModule('child_process');
    const original = cp.execFile;
    globalThis.externalCalls = [];
    globalThis.chromeMissing = false;
    cp.execFile = (file, args, callback) => {
      if (file !== '/usr/bin/open') return original(file, args, callback);
      globalThis.externalCalls.push({ file, args });
      callback(globalThis.chromeMissing ? new Error('Chrome missing') : null, '', '');
    };
    shell.openExternal = async (url) => {
      globalThis.externalCalls.push({ default: url });
    };
  });
  await page.getByRole('button', { name: 'Opciones del navegador', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir en Chrome', exact: true }).click();
  const launches = await app.evaluate(() => globalThis.externalCalls);
  assert.deepEqual(launches[0], {
    file: '/usr/bin/open',
    args: ['-a', 'Google Chrome', origin + '/'],
  });
  await app.evaluate(() => {
    globalThis.chromeMissing = true;
  });
  await call({ type: 'browserOpenExternal', tabId: parent.id });
  assert.deepEqual((await app.evaluate(() => globalThis.externalCalls)).at(-1), {
    default: origin + '/app',
  });
  await click(popup.id, 'Aceptar');
  await until(async () => !(await snapshot()).browsers.some((b) => b.id === popup.id));
  assert.match((await act(parent.id, { action: 'inspect' })).text, /Autorizado/);
  await click(parent.id, 'Ventana en blanco');
  const blank = await until(async () =>
    (await snapshot()).browsers.find((b) => b.url === origin + '/blank-callback' && !b.loading),
  );
  assert.match((await act(blank.id, { action: 'inspect' })).text, /opener:true/);
  await click(blank.id, 'Cerrar');
  await until(async () => !(await snapshot()).browsers.some((b) => b.id === blank.id));
  await click(parent.id, 'Enviar formulario');
  const post = await until(async () =>
    (await snapshot()).browsers.find((b) => b.url === origin + '/post-callback' && !b.loading),
  );
  // Popup metadata can precede Chromium's native POST navigation.
  await until(() => requests.some((r) => r.path === '/post-callback'));
  assert.ok(
    requests.some(
      (r) => r.path === '/post-callback' && r.method === 'POST' && r.body === 'state=test-state',
    ),
  );
  assert.match((await act(post.id, { action: 'inspect' })).text, /persistent:true pkce:true/);
  await click(post.id, 'Cerrar');
  await until(async () => !(await snapshot()).browsers.some((b) => b.id === post.id));
  const before = (await snapshot()).browsers.length;
  await click(parent.id, 'Esquema bloqueado');
  assert.equal((await snapshot()).browsers.length, before);
  const same = await call({ type: 'browserNew', projectId: 'p', url: origin + '/check' });
  assert.match(
    (await act(same.id, { action: 'inspect' })).text,
    /persistent:true pkce:true local:saved/,
  );
  assert.ok(requests.some((r) => r.path === '/check' && r.cookie.includes('fixture-partitioned=')));
  const other = await call({ type: 'browserNew', projectId: 'q', url: origin + '/isolated' });
  assert.match(
    (await act(other.id, { action: 'inspect' })).text,
    /persistent:false pkce:false local:null/,
  );
  // Auth URLs are restarted at the application, not transferred with old PKCE state.
  const auth = await call({
    type: 'browserNew',
    projectId: 'p',
    url: origin + '/api/auth/callback/google?code=fixture&state=fixture',
  });
  await call({ type: 'browserOpenExternal', tabId: auth.id });
  assert.deepEqual((await app.evaluate(() => globalThis.externalCalls)).at(-1), {
    default: origin + '/',
  });
  await page
    .getByText('Si el acceso falla aquí, inicia sesión en Chrome.', { exact: false })
    .waitFor();
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/browser-auth.png' });
  await app.close();
  app = undefined;
  const saved = JSON.parse(await fs.readFile(path.join(data, 'browser-tabs.json'), 'utf8'));
  assert.equal(saved.find((t) => t.id === auth.id).url, origin + '/');
  await launch();
  assert.equal((await snapshot()).browsers.find((b) => b.id === same.id).suspended, true);
  await act(same.id, { action: 'reload' });
  assert.match(
    (await act(same.id, { action: 'inspect' })).text,
    /persistent:true pkce:true local:saved/,
  );
  assert.equal(requests.at(-1).cookie.includes('fixture-partitioned='), false);
  await act(other.id, { action: 'reload' });
  assert.match(
    (await act(other.id, { action: 'inspect' })).text,
    /persistent:false pkce:false local:null/,
  );
  await call({ type: 'removeProject', projectId: 'p' });
  const remaining = await app.evaluate(async ({ session }, url) => {
    const ses = session.fromPartition('persist:desk-browser-p');
    return (await ses.cookies.get({ url })).filter((c) => c.name.startsWith('fixture-')).length;
  }, origin);
  assert.equal(remaining, 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: native popup/opener/postMessage/close, about:blank, POST form, shared PKCE cookie, isolated projects, persistent and session cookies after restart, CHIPS not broadened, localStorage, clearing removed-project cookies, Chrome launcher and default fallback, OAuth restart URL, blocked schemes. Synthetic local data only.',
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
