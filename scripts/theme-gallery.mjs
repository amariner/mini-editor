// Screenshot gallery of the main surfaces in every shipped theme, light and dark.
// Renderer fixture only: no accounts, agents or model calls. Output: artifacts/theme-gallery.
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const protocol = Number(
  (await fs.readFile('src/runtime.ts', 'utf8')).match(/IPC_VERSION = (\d+)/)[1],
);
const themes = [{ id: 'original', css: '' }];
for (const file of (await fs.readdir('themes')).filter((f) => f.endsWith('.css')).sort())
  themes.push({ id: file.slice(0, -4), css: await fs.readFile(path.join('themes', file), 'utf8') });

const only = process.argv.slice(2);
const out = 'artifacts/theme-gallery';
await fs.mkdir(out, { recursive: true });
const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-gallery-'));
let server;
let browser;
const answer = [
  'He revisado los dos repositorios y ya están al día con `origin/main`.',
  '',
  '- **logicflow-lab**: 8 ficheros de documentación, entre ellos [docs/wiki/diseno.md](docs/wiki/diseno.md).',
  '- **logicflows**: la rama `test/LF-116` se fusionó como `ac1864b`.',
  '',
  '| Repo | Commits | Estado |',
  '|:--|--:|:--|',
  '| `logicflow-lab` | 8 | al día |',
  '| `logicflows` | 17 | al día |',
  '',
  '> [!WARNING]',
  '> La versión **v0.5.0** cambia el formato de los tokens.',
  '',
  '```ts',
  "import { tokens } from '@logicflows/design-tokens';",
  '// Colores base del tema',
  'export function theme(dark: boolean) {',
  '  return dark ? tokens.dark : tokens.light;',
  '}',
  '```',
].join('\n');
try {
  await build({ build: { outDir: buildDir, emptyOutDir: true }, logLevel: 'silent' });
  server = await preview({
    build: { outDir: buildDir },
    preview: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
  });
  browser = await chromium.launch({ headless: true });
  for (const theme of themes) {
    if (only.length && !only.includes(theme.id)) continue;
    for (const colorScheme of ['light', 'dark']) {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 820 },
        colorScheme,
        reducedMotion: 'reduce',
        deviceScaleFactor: 1,
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(
        ({ protocol, css, answer, themeId }) => {
          if (css) {
            localStorage.setItem('agent-desk.styles.v1', css);
            localStorage.setItem('agent-desk.styles.theme.v1', `builtin:${themeId}`);
          }
          const now = Date.now();
          const messages = [
            {
              id: 'u1',
              role: 'user',
              text: 'Baja los cambios de los dos repos y resume',
              at: now - 600000,
            },
            {
              id: 'a1',
              role: 'assistant',
              text: '',
              model: 'claude-sonnet-4-5-20250929',
              durationMs: 83000,
              blocks: [
                { type: 'thinking', text: 'Compruebo el estado de cada repo.', final: true },
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'Bash',
                  input: { command: 'git -C ../logicflow-lab pull --ff-only' },
                  done: true,
                  ms: 2300,
                  result: 'Fast-forward\n 8 files changed, 412 insertions(+), 37 deletions(-)',
                },
                {
                  type: 'tool_use',
                  id: 't5',
                  name: 'Edit',
                  input: {
                    file_path: '/tmp/gallery/README.md',
                    old_string: 'Versión 0.4.0',
                    new_string: 'Versión 0.5.0',
                  },
                  done: true,
                  result: 'ok',
                },
                { type: 'text', text: answer, final: true },
              ],
            },
            { id: 'u2', role: 'user', text: 'Perfecto, borra la rama local', at: now - 60000 },
          ];
          const projects = [
            'logicflows',
            'mini-editor',
            'porcelanosa-web',
            'catalogo-2027',
            'api-pedidos',
          ].map((name, i) => ({ id: `p${i}`, name, path: `/tmp/gallery/${name}` }));
          const sessions = [
            {
              id: 's0',
              projectId: 'p0',
              title: 'Actualizar repos',
              messages,
              approvals: [
                {
                  id: 'ap1',
                  method: 'can_use_tool',
                  params: {},
                  tool: 'Bash',
                  input: { command: 'git branch -D test/LF-116', description: 'Borrar rama local' },
                },
              ],
              status: 'running',
            },
            {
              id: 's1',
              projectId: 'p0',
              title: 'Revisar tokens de diseño',
              messages: [],
              status: 'ready',
            },
            {
              id: 's2',
              projectId: 'p0',
              title: 'Tests del reloj virtual',
              messages: [],
              status: 'ready',
            },
            { id: 's3', projectId: 'p1', title: 'Pulir interfaz', messages: [], status: 'ready' },
            { id: 's4', projectId: 'p2', title: 'Migrar a Astro', messages: [], status: 'ready' },
          ].map((s) => ({
            profile: 'claude-1',
            mode: 'chat',
            approvals: [],
            stats: {
              cost: 0,
              turns: 2,
              inputTokens: 48200,
              outputTokens: 2310,
              durationMs: 1000,
              tokensReported: true,
              contextPercent: 34,
              contextTokens: 68000,
              contextMax: 200000,
            },
            ...s,
          }));
          const state = {
            profiles: [
              { id: 'claude-1', kind: 'claude', name: 'Trabajo' },
              { id: 'codex-1', kind: 'codex', name: 'Personal' },
            ],
            defaultProfile: 'claude-1',
            accounts: {
              'claude-1': { status: 'signedIn', label: 'trabajo@example.test' },
              'codex-1': { status: 'signedIn', label: 'personal@example.test' },
            },
            projects,
            sessions,
            selectedProject: 'p0',
            selectedSession: 's0',
            tools: {},
            coordination: [],
            runtime: { protocol },
            dataDir: '/tmp/gallery',
            theme: 'system',
          };
          const listeners = new Set();
          window.fixture = {
            state,
            publish() {
              for (const fn of listeners) fn({ type: 'state', state: structuredClone(state) });
            },
          };
          window.desk = {
            subscribe(fn) {
              listeners.add(fn);
              return () => listeners.delete(fn);
            },
            async invoke(action) {
              if (action.type === 'snapshot') return structuredClone(state);
              if (action.type === 'diff')
                return {
                  repository: true,
                  branch: 'main',
                  files: [{ path: 'README.md', status: 'M' }],
                  branches: ['main'],
                  counts: {},
                  commits: [],
                  lines: { added: 12, removed: 3 },
                };
              if (action.type === 'listFiles') return [];
              if (action.type === 'select') {
                state.selectedProject = action.projectId;
                state.selectedSession = action.sessionId;
                window.fixture.publish();
              }
              return true;
            },
          };
        },
        { protocol, css: theme.css, answer, themeId: theme.id },
      );
      const shot = (name) =>
        page.screenshot({ path: path.join(out, `${theme.id}-${colorScheme}-${name}.png`) });
      await page.goto(server.resolvedUrls.local[0]);
      await page
        .locator('.workspace .composer')
        .waitFor()
        .catch(async (error) => {
          console.log(errors);
          throw error;
        });
      await page.waitForTimeout(300);
      await shot('1-chat');
      await page.locator('.workspace .composer textarea').focus();
      await page.waitForTimeout(150);
      await shot('2-composer-focus');
      await page.evaluate(() => {
        const s = window.fixture.state;
        s.selectedProject = 'p3';
        s.selectedSession = undefined;
        window.fixture.publish();
      });
      await page.waitForTimeout(250);
      await shot('3-empty');
      await page.evaluate(() => {
        const s = window.fixture.state;
        s.selectedProject = 'p0';
        s.selectedSession = 's1';
        window.fixture.publish();
      });
      await page.waitForTimeout(250);
      await shot('4-new-chat');
      await page.keyboard.press('Meta+k');
      await page.waitForTimeout(250);
      await shot('5-palette');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
      await page.getByRole('dialog', { name: 'Ajustes', exact: true }).waitFor();
      await page.waitForTimeout(250);
      await shot('6-settings-accounts');
      await page.getByRole('tab', { name: 'Interfaz', exact: true }).click();
      await page.waitForTimeout(400);
      await shot('7-settings-interface');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Meta+b');
      await page.waitForTimeout(300);
      await shot('8-sidebar-collapsed');
      if (errors.length) console.log(theme.id, colorScheme, errors);
      await page.close();
    }
  }
  console.log(`Galería en ${out}`);
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(buildDir, { recursive: true, force: true });
}
