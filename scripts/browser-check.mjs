import { createTestAccounts } from './test-accounts.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-browser-')));
const folder = path.join(root, 'Proyecto navegador');
await fs.mkdir(folder);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<!doctype html><html lang="es"><head><title>Vista de prueba</title><style>body{font:16px system-ui;background:#f2f0e9;color:#222;padding:28px}h1{font-size:28px}button,input{padding:12px;border:1px solid #bbb;border-radius:8px;margin:8px 0}button{background:#e7c765}a{display:block;margin:20px 0}</style></head><body><h1>Vista previa local</h1><p>Un navegador real dentro de Agent Desk.</p><input aria-label="Nombre" placeholder="Tu nombre"><button onclick="document.querySelector('#result').textContent='Hola '+document.querySelector('input').value">Saludar</button><p id="result">Sin enviar</p><a href="/next">Otra página</a><input type="password" aria-label="Clave" value="not-for-agents"><p>Ruta: ${req.url}</p></body></html>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
let app, page;
const errors = [];
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snap = () => call({ type: 'snapshot' });
const until = async (fn) => {
  for (let i = 0; i < 150; i++) {
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(100);
  }
  throw new Error('Timeout');
};
try {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      AGENT_DESK_DEV_URL: '',
      AGENT_DESK_DATA_DIR: path.join(root, 'data'),
      AGENT_DESK_PROFILES_DIR: '',
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.desk);
  await createTestAccounts(page);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  await page.getByRole('button', { name: 'Añadir proyecto', exact: true }).first().click();
  await page.locator('.chat-watermark').waitFor();
  assert.equal(await page.locator('.search-trigger').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Buscar proyectos y sesiones' }).count(), 1);
  assert.equal(await page.locator('.composer-hint, .conv-foot, .crumb > strong').count(), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundImage), 'none');
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  await page.getByRole('textbox', { name: 'Dirección web' }).fill(url);
  await page.getByRole('button', { name: 'Ir a la dirección' }).click();
  const first = (await snap()).selectedSession;
  const browser = (input) => call({ type: 'browser', sessionId: first, input });
  await until(async () =>
    (await snap()).browsers?.some((b) => b.sessionId === first && !b.loading && b.url === url),
  );
  const inspect = await browser({ action: 'inspect' });
  assert.ok(inspect.text.includes('Vista previa local'));
  assert.ok(!JSON.stringify(inspect).includes('not-for-agents'));
  const input = inspect.elements.find((e) => e.label === 'Nombre');
  const button = inspect.elements.find((e) => e.label === 'Saludar');
  await browser({ action: 'fill', ref: input.ref, text: 'Agent Desk' });
  await browser({ action: 'click', ref: button.ref });
  assert.ok((await browser({ action: 'inspect' })).text.includes('Hola Agent Desk'));
  const shot = await browser({ action: 'screenshot' });
  assert.equal(shot.mimeType, 'image/png');
  assert.ok(Buffer.from(shot.image, 'base64').length > 1000);
  await assert.rejects(browser({ action: 'navigate', url: 'file:///etc/passwd' }));
  // Inspect actual guest privileges, not a mock connection.
  const isolated = await app.evaluate(async ({ webContents }, url) => {
    const w = webContents.getAllWebContents().find((w) => w.getURL() === url);
    return w.executeJavaScript('({node:typeof require,bridge:typeof window.desk})');
  }, url);
  assert.deepEqual(isolated, { node: 'undefined', bridge: 'undefined' });
  await page.keyboard.press('Meta+k');
  await page.getByPlaceholder('Buscar proyecto o sesión…').waitFor();
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.filter(
          (v) => v !== BrowserWindow.getAllWindows()[0].contentView.children[0] && v.getVisible(),
        ).length,
    ),
    0,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  assert.ok((await browser({ action: 'inspect' })).text.includes('Hola Agent Desk'));
  await call({
    type: 'newSession',
    projectId: (await snap()).selectedProject,
    profile: 'claude-2',
  });
  await until(async () => (await snap()).selectedSession !== first);
  const second = (await snap()).selectedSession;
  await call({ type: 'browser', sessionId: second, input: { action: 'navigate', url } });
  assert.ok(
    !(
      await call({ type: 'browser', sessionId: second, input: { action: 'inspect' } })
    ).text.includes('Hola Agent Desk'),
  );
  const backgroundShot = await browser({ action: 'screenshot' });
  assert.ok(
    Buffer.from(backgroundShot.image, 'base64').length > 1000,
    'Background screenshot is empty',
  );
  await call({ type: 'select', projectId: (await snap()).selectedProject, sessionId: first });
  await until(async () => (await snap()).selectedSession === first);
  await page.waitForTimeout(300);
  await fs.mkdir('artifacts', { recursive: true });
  // Native views are composited outside the renderer screenshot.
  const visibleViews = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.filter((v) => 'webContents' in v)
      .map((v) => ({
        visible: v.getVisible(),
        bounds: v.getBounds(),
        url: v.webContents.getURL(),
      })),
  );
  assert.ok(
    visibleViews.some(
      (v) => v.visible && v.url === url && v.bounds.width > 200 && v.bounds.height > 100,
    ),
    JSON.stringify(visibleViews),
  );
  const guestCapture = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
      (v) =>
        'webContents' in v &&
        v.getVisible() &&
        v.webContents.getURL().startsWith('http://127.0.0.1:'),
    );
    return (await view.webContents.capturePage()).toPNG().toString('base64');
  });
  assert.ok(
    Buffer.from(guestCapture, 'base64').length > 1000,
    'Visible native page screenshot is empty',
  );
  await fs.writeFile('artifacts/34-pagina-navegador.png', Buffer.from(guestCapture, 'base64'));
  const capture = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'),
  );
  await fs.writeFile('artifacts/33-navegador-integrado.png', Buffer.from(capture, 'base64'));
  await call({ type: 'newSession', projectId: (await snap()).selectedProject, profile: 'codex' });
  const background = (await snap()).selectedSession;
  await call({ type: 'select', projectId: (await snap()).selectedProject, sessionId: first });
  await call({ type: 'browser', sessionId: background, input: { action: 'navigate', url } });
  const unseenShot = await call({
    type: 'browser',
    sessionId: background,
    input: { action: 'screenshot' },
  });
  assert.ok(
    Buffer.from(unseenShot.image, 'base64').length > 1000,
    'Never-visible page screenshot is empty',
  );
  await fs.writeFile(
    'artifacts/35-navegador-segundo-plano.png',
    Buffer.from(unseenShot.image, 'base64'),
  );
  // Resize across a native browser surface: pointer capture must survive until release.
  await page.getByRole('button', { name: 'Plegar proyectos' }).click();
  const mark = await page.locator('.project-mark').first().innerHTML();
  const rail = await page.locator('.sidebar').boundingBox();
  assert.equal(rail.width, 40);
  assert.equal(await page.locator('.project-initial').count(), 0);
  const divider = page.getByRole('separator', { name: 'Ancho del chat' });
  await page.waitForTimeout(250);
  const bounds = await divider.boundingBox();
  const workspace = await page.locator('.workspace').boundingBox();
  await page.mouse.move(bounds.x + 4, bounds.y + 80);
  await page.mouse.down();
  await page.mouse.move(workspace.x + 220, bounds.y + 80, { steps: 12 });
  await page.mouse.up();
  await until(
    async () => Math.abs((await page.locator('.conversation').boundingBox()).width - 220) < 2,
  );
  assert.ok((await page.locator('.tools-drawer').boundingBox()).width > workspace.width * 0.7);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await until(
    async () =>
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return w.contentView.children.some(
          (v) =>
            'webContents' in v &&
            v.getVisible() &&
            v.webContents.getURL().startsWith('http://127.') &&
            v.getBounds().width > 800,
        );
      }),
  );
  await page.screenshot({ path: 'artifacts/36-minimal-chat-estrecho.png' });
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), 244);
  await page.keyboard.press('End');
  assert.ok((await page.locator('.tools-drawer').boundingBox()).width >= 239);
  await page.keyboard.press('Home');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 620),
  );
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.ok(
    (await page.getByRole('button', { name: 'Enviar', exact: true }).boundingBox()).width > 20,
  );
  await page.screenshot({ path: 'artifacts/37-minimal-compacto.png' });
  await page.reload();
  await page.locator('.chat-watermark').waitFor();
  assert.equal(await page.locator('.project-mark').first().innerHTML(), mark);
  await page.getByRole('button', { name: 'Navegador', exact: true }).click();
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), 220);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.locator('.bottom-terminal .xterm').waitFor();
  await until(
    async () =>
      await page
        .locator('.bottom-terminal .xterm-helper-textarea')
        .evaluate((el) => el === document.activeElement),
  );
  assert.equal(
    await page.getByRole('button', { name: 'Ocultar terminal', exact: true }).count(),
    0,
  );
  await page.keyboard.type('printf "terminal-lista\\n"');
  await page.keyboard.press('Enter');
  const shellId = (await snap()).terminals[0].id;
  await until(async () =>
    (
      await page.evaluate(
        (id) => window.desk.invoke({ type: 'terminalBuffer', sessionId: id }),
        shellId,
      )
    ).data.includes('terminal-lista\r\n'),
  );
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  assert.equal(await page.locator('.bottom-terminal').count(), 0);
  assert.ok((await snap()).terminals.some((t) => t.id === shellId));
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await until(
    async () =>
      await page
        .locator('.bottom-terminal .xterm-helper-textarea')
        .evaluate((el) => el === document.activeElement),
  );
  const lower = await page.locator('.bottom-terminal').boundingBox();
  await until(
    async () =>
      await app.evaluate(({ BrowserWindow }, y) => {
        const host = BrowserWindow.getAllWindows()[0];
        return host.contentView.children.some(
          (v) =>
            'webContents' in v &&
            v.getVisible() &&
            v.webContents.getURL().startsWith('http://127.') &&
            v.getBounds().y + v.getBounds().height <= y,
        );
      }, lower.y),
  );
  await page.getByRole('button', { name: 'Ocultar navegador', exact: true }).click();
  assert.ok((await snap()).browsers.some((b) => b.sessionId === first));
  await browser({ action: 'close' });
  await until(async () => !(await snap()).browsers.some((b) => b.sessionId === first));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: minimal layout, stable project marks, pointer/keyboard resizing, 220px chat, saved split, CmdK, real browser navigation/DOM/click/fill/screenshot, credential redaction, renderer isolation, modal visibility, session separation, close lifecycle.',
  );
} finally {
  if (app) await app.close();
  await new Promise((r) => server.close(r));
}
