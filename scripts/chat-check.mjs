import { createTestAccounts } from './test-accounts.mjs';
// Real Electron + real Claude Code through the Agent SDK. Uses the authenticated profiles of this
// machine (AGENT_DESK_PROFILES_DIR) with an isolated state directory and a temporary project.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const profiles = process.env.AGENT_DESK_PROFILES_DIR;
if (!profiles) throw new Error('Define AGENT_DESK_PROFILES_DIR con los perfiles autenticados.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-chat-'));
const data = path.join(root, 'data'),
  project = path.join(root, 'Proyecto chat');
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'notas.md'), '# Notas\n\nPrimera línea de prueba.\n');
await fs.mkdir('artifacts', { recursive: true });
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, AGENT_DESK_DATA_DIR: data, AGENT_DESK_DEV_URL: '' },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => !!window.desk);
await createTestAccounts(page);
await page.setViewportSize({ width: 1380, height: 880 });
const call = (a) => page.evaluate((a) => window.desk.invoke(a), a);
const snapshot = () => call({ type: 'snapshot' });
const report = [];
async function until(fn, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timeout esperando estado real');
}
const current = async () => {
  const s = await snapshot();
  return s.sessions.find((x) => x.id === s.selectedSession);
};
try {
  await page.screenshot({ path: 'artifacts/10-inicio.png' });
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await page.getByRole('button', { name: 'Añadir proyecto', exact: true }).first().click();
  await until(async () => (await snapshot()).projects.length === 1);
  await page.screenshot({ path: 'artifacts/11-proyecto-vacio.png' });
  let s = await current();
  assert.equal(s.mode, 'chat');
  // Configure before opening: Haiku keeps the check cheap.
  await call({ type: 'configure', sessionId: s.id, config: { model: 'haiku' } });
  await page.screenshot({ path: 'artifacts/12-controles-compositor.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/18-oscuro.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  // Typing into the composer opens the agent automatically.
  const box = page.getByRole('textbox', { name: 'Mensaje' });
  await box.fill('Lee notas.md y resume su contenido en una frase.');
  await page.keyboard.press('Enter');
  s = await until(async () => {
    const x = await current();
    return x.status === 'ready' && x.messages.some((m) => m.role === 'assistant') ? x : undefined;
  });
  const assistant = s.messages.filter((m) => m.role === 'assistant');
  assert.ok(
    assistant.some((m) =>
      m.blocks?.some((b) => b.type === 'tool_use' && b.name === 'Read' && b.done),
    ),
  );
  assert.ok(assistant.some((m) => m.blocks?.some((b) => b.type === 'text' && b.text.length > 10)));
  assert.ok(s.account, 'cuenta visible');
  assert.ok(s.info?.models.length > 1, 'modelos listados');
  assert.ok(s.info?.commands.length > 5, 'comandos listados');
  assert.ok(s.stats?.cost > 0, 'coste registrado');
  report.push(
    `Turno real con Read: ${assistant.length} mensajes, coste ${s.stats.cost.toFixed(4)} USD, contexto ${s.stats.contextPercent}%.`,
  );
  await page.screenshot({ path: 'artifacts/13-chat-respuesta.png' });
  // A write needs permission in the default mode: the card must appear and the file must not exist yet.
  await box.fill('Crea el archivo creado.txt con el texto "hola desde agent desk". No preguntes.');
  await page.keyboard.press('Enter');
  s = await until(async () => {
    const x = await current();
    return x.approvals.length ? x : undefined;
  });
  assert.equal(s.status, 'waiting');
  assert.equal(s.approvals[0].tool, 'Write');
  assert.equal(
    await fs.access(path.join(project, 'creado.txt')).then(
      () => true,
      () => false,
    ),
    false,
  );
  await page.screenshot({ path: 'artifacts/14-permiso.png' });
  await page.getByRole('button', { name: 'Permitir', exact: true }).click();
  s = await until(async () => {
    const x = await current();
    return x.status === 'ready' && !x.approvals.length ? x : undefined;
  });
  assert.equal(
    (await fs.readFile(path.join(project, 'creado.txt'), 'utf8')).includes('hola desde agent desk'),
    true,
  );
  report.push('Permiso real de Write mostrado, aprobado una vez y archivo creado.');
  // AskUserQuestion renders option tiles; the chosen label reaches Claude as the answer.
  await box.fill(
    'Usa la herramienta AskUserQuestion para preguntarme si prefiero "Verde" o "Azul" (dos opciones, una pregunta). Después responde solo con el color elegido.',
  );
  await page.keyboard.press('Enter');
  s = await until(async () => {
    const x = await current();
    return x.approvals.some((a) => a.tool === 'AskUserQuestion') ? x : undefined;
  });
  await page.screenshot({ path: 'artifacts/17-pregunta.png' });
  await page.locator('.approval.ask .tile').filter({ hasText: 'Azul' }).first().click();
  await page.getByRole('button', { name: 'Enviar respuesta' }).click();
  s = await until(async () => {
    const x = await current();
    const last = x.messages.at(-1);
    return x.status === 'ready' &&
      last?.role === 'assistant' &&
      last.blocks?.some((b) => b.type === 'text')
      ? x
      : undefined;
  });
  assert.match(
    s.messages
      .at(-1)
      .blocks.filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' '),
    /Azul/i,
  );
  report.push('Pregunta real de AskUserQuestion respondida desde las opciones.');
  // Local slash commands and live reconfiguration.
  await box.fill('/cost');
  await page.keyboard.press('Enter');
  await until(async () =>
    (await current()).messages.some((m) => m.kind === 'command' && /Coste/.test(m.text)),
  );
  await box.fill('/');
  await page.waitForSelector('.slash-menu');
  await page.screenshot({ path: 'artifacts/15-comandos.png' });
  await box.fill('');
  const r = await call({
    type: 'configure',
    sessionId: s.id,
    config: { permissionMode: 'acceptEdits' },
  });
  assert.equal(r.restart, false);
  s = await current();
  assert.equal(s.info.permissionMode, 'acceptEdits');
  report.push('Modo de permisos cambiado en caliente a acceptEdits.');
  // Interrupt a longer turn.
  await box.fill('Cuenta despacio del 1 al 300 escribiendo cada número en una línea.');
  await page.keyboard.press('Enter');
  await until(async () => (await current()).status === 'working');
  await new Promise((r) => setTimeout(r, 2500));
  await call({ type: 'interrupt', sessionId: s.id });
  s = await until(async () => {
    const x = await current();
    return x.status === 'ready' ? x : undefined;
  });
  report.push('Interrupción de un turno real confirmada.');
  // Resume after stop: history stays and the CLI session continues.
  await call({ type: 'stop', sessionId: s.id });
  await until(async () => (await current()).status === 'stopped');
  const before = (await current()).messages.length;
  await call({ type: 'start', sessionId: s.id });
  await until(async () => (await current()).status === 'ready');
  s = await current();
  assert.equal(s.messages.length, before, 'sin duplicados al reanudar');
  await box.fill('¿Cómo se llamaba el archivo que creaste antes? Responde solo con el nombre.');
  await page.keyboard.press('Enter');
  s = await until(async () => {
    const x = await current();
    const last = x.messages.at(-1);
    return x.status === 'ready' && last?.role === 'assistant' ? x : undefined;
  });
  const lastText = s.messages
    .at(-1)
    .blocks.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
  assert.match(lastText, /creado\.txt/);
  report.push('Reanudación real: Claude recuerda la conversación tras cerrar y abrir.');
  await page.screenshot({ path: 'artifacts/16-reanudada.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/19-chat-oscuro.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  // Codex: controls remain in the composer before the ChatGPT login.
  await call({ type: 'select', projectId: (await snapshot()).projects[0].id, profile: 'codex' });
  await page.getByRole('button', { name: 'Modelo de Codex', exact: true }).waitFor();
  const codexSession = await current();
  assert.equal(codexSession.profile, 'codex');
  const cr = await call({
    type: 'configureCodex',
    sessionId: codexSession.id,
    config: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  });
  assert.equal(cr.restart, false);
  assert.equal((await current()).codexConfig.sandbox, 'read-only');
  await page.screenshot({ path: 'artifacts/20-codex-config.png' });
  await page.keyboard.press('Escape');
  report.push('Controles de Codex en el compositor; configuración avanzada guardada conservada.');
  await call({ type: 'select', projectId: (await snapshot()).projects[0].id, sessionId: s.id });
  await call({ type: 'stop', sessionId: s.id });
  await until(async () => (await current()).status === 'stopped');
  assert.deepEqual(errors, []);
  await fs.writeFile('artifacts/chat-report.json', JSON.stringify({ ok: true, report }, null, 2));
  console.log(report.join('\n'));
} catch (e) {
  await page.screenshot({ path: 'artifacts/99-error.png' }).catch(() => {});
  const s = await snapshot().catch(() => undefined);
  await fs.writeFile(
    'artifacts/chat-report.json',
    JSON.stringify({ ok: false, error: e.message, errors, state: s }, null, 2),
  );
  console.error('FALLO:', e.message);
  process.exitCode = 1;
} finally {
  await app.close().catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}
