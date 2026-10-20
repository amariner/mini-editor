// Isolated Electron check: real IPC and native speech, muted; intercept only the Finder launch.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-response-actions-')));
const project = path.join(root, 'project'),
  data = path.join(root, 'data');
await fs.mkdir(path.join(project, 'informes'), { recursive: true });
await fs.mkdir(data);
await fs.writeFile(path.join(project, 'informes', 'seguimiento.pdf'), '%PDF-1.4\n%%EOF');
await fs.writeFile(path.join(project, 'notas.md'), '# Notas');
await fs.writeFile(
  path.join(data, 'state.json'),
  JSON.stringify({
    profiles: [{ id: 'claude-1', name: 'Test', kind: 'claude' }],
    projects: [{ id: 'p', name: 'Proyecto', path: project }],
    sessions: [
      {
        id: 's',
        projectId: 'p',
        profile: 'claude-1',
        title: 'Entregables',
        messages: [
          { id: 'u1', role: 'user', text: 'Prepara el informe.' },
          {
            id: 'a1',
            role: 'assistant',
            text: 'He preparado el informe.\n\n**Entregable:** `informes/seguimiento.pdf` (3 páginas).\n\nConsulta las [notas](notas.md). Puedes revisar los resultados con calma y compartir el documento cuando esté listo.',
          },
          { id: 'u2', role: 'user', text: '¿Algo más?' },
          {
            id: 'a2',
            role: 'assistant',
            text: 'Revisa los datos del último mes antes de comparar los resultados. Esta respuesta también se puede leer en voz alta desde su propio botón.',
          },
        ],
      },
    ],
    selectedProject: 'p',
    selectedSession: 's',
    tools: { claude: '/usr/bin/false', codex: '/usr/bin/false' },
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
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.desk);
  await app.evaluate(({ shell }) => {
    globalThis.revealedFiles = [];
    shell.showItemInFolder = (filename) => {
      globalThis.revealedFiles.push(filename);
    };
    shell.openPath = async () => {
      throw Error('Debe mostrar el archivo en su carpeta');
    };
  });
  await page.getByRole('link', { name: 'informes/seguimiento.pdf', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.revealedFiles), [
    path.join(project, 'informes', 'seguimiento.pdf'),
  ]);
  const notes = page.getByRole('link', { name: 'notas', exact: true });
  await notes.focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await app.evaluate(() => globalThis.revealedFiles), [
    path.join(project, 'informes', 'seguimiento.pdf'),
    path.join(project, 'notas.md'),
  ]);
  const groups = page.locator('.workspace .response-group');
  await groups.first().hover();
  const copy = groups.first().getByRole('button', { name: 'Copiar respuesta', exact: true });
  const read = groups
    .first()
    .getByRole('button', { name: 'Leer respuesta en voz alta', exact: true });
  const copyBox = await copy.boundingBox(),
    readBox = await read.boundingBox();
  assert.ok(readBox.x > copyBox.x);
  assert.ok(Math.abs(readBox.y - copyBox.y) < 2);
  await page.evaluate(() => {
    window.spokenChunks = [];
    window.nativeStarts = 0;
    const speak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (utterance) => {
      utterance.volume = 0; // Exercise the real OS engine without playing test audio.
      window.spokenChunks.push(utterance.text);
      utterance.addEventListener('start', () => {
        window.nativeStarts++;
      });
      speak(utterance);
    };
    speechSynthesis.getVoices();
  });
  await page.waitForFunction(() =>
    speechSynthesis.getVoices().some((v) => v.lang.startsWith('es') && v.localService),
  );
  await read.click();
  await page.waitForFunction(() => window.nativeStarts > 0);
  await groups.first().getByRole('button', { name: 'Detener lectura', exact: true }).waitFor();
  assert.ok(
    (await page.evaluate(() => window.spokenChunks[0])).includes('He preparado el informe.'),
  );
  await groups.last().hover();
  await groups
    .last()
    .getByRole('button', { name: 'Leer respuesta en voz alta', exact: true })
    .click();
  assert.equal(await page.getByRole('button', { name: 'Detener lectura', exact: true }).count(), 1);
  await groups
    .first()
    .getByRole('button', { name: 'Leer respuesta en voz alta', exact: true })
    .waitFor();
  await groups.last().getByRole('button', { name: 'Detener lectura', exact: true }).click();
  await page.waitForFunction(() => !speechSynthesis.speaking);
  await groups.first().hover();
  await copy.click();
  assert.ok(
    (await page.evaluate(() => navigator.clipboard.readText())).includes('**Entregable:**'),
  );
  await fs.mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/response-actions.png' });
  await groups
    .first()
    .getByRole('button', { name: 'Leer respuesta en voz alta', exact: true })
    .click();
  await page.evaluate(() =>
    window.desk.invoke({ type: 'newSession', projectId: 'p', profile: 'claude-1' }),
  );
  await page.waitForFunction(() => !speechSynthesis.speaking);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: inline-code PDF and Markdown links reveal the exact file through IPC, keyboard activation, reader to the right of copy, native Spanish speech (muted), exclusive reading, stop, chat-switch cleanup, and copy. No model calls.',
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
