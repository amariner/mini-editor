// Synthetic renderer benchmark: no accounts, model calls or production instrumentation.
// Counts actual row renders rather than relying on noisy wall-clock speed assertions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-desk-streaming-'));
let browser;
let server;
try {
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ConversationMessages } from './src/chat';
import { reconcileSnapshot } from './src/state-sharing';
window.__renderCounts = { history: 0, active: 0 };
let root;
window.measure = (sharing, turns = 500, updates = 25) => {
  if (root) flushSync(() => root.unmount());
  root = createRoot(document.getElementById('root'));
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ id: 'user-' + i, role: 'user', text: 'Inspect the project ' + i });
    messages.push({ id: 'reply-' + i, role: 'assistant', text: '', blocks: [
      { type: 'text', text: 'Inspecting files ' + i },
      { type: 'tool_use', id: 'tool-' + i, name: 'Read', input: { file_path: '/tmp/a.ts' }, done: true, result: 'output'.repeat(100) },
      { type: 'text', text: 'Completed response **' + i + '**', final: true },
    ] });
  }
  messages.push({ id: 'live-user', role: 'user', text: 'Continue' });
  messages.push({ id: 'live-answer', role: 'assistant', text: 'Streaming' });
  let state = { projects: [], tools: {}, dataDir: '/tmp/fixture', sessions: [{ id: 's', projectId: 'p', profile: 'claude-1', title: 'Performance', status: 'working', approvals: [], messages }] };
  const render = () => flushSync(() => root.render(<ConversationMessages session={state.sessions[0]} kind="claude" />));
  render();
  window.__renderCounts = { history: 0, active: 0 };
  let reconciliationMs = 0;
  let renderMs = 0;
  let retained = 0;
  for (let i = 0; i < updates; i++) {
    const incoming = structuredClone(state);
    incoming.sessions[0].messages.at(-1).text += ' delta';
    const before = state;
    const started = performance.now();
    state = sharing ? reconcileSnapshot(state, incoming) : incoming;
    reconciliationMs += performance.now() - started;
    retained = state.sessions[0].messages.filter((message, index) => message === before.sessions[0].messages[index]).length;
    const rendering = performance.now();
    render();
    renderMs += performance.now() - rendering;
  }
  return { turns, updates, ...window.__renderCounts, retainedMessages: retained, reconciliationMs: +reconciliationMs.toFixed(2), renderMs: +renderMs.toFixed(2), hiddenToolRows: document.querySelectorAll('.response-work .tool.step').length };
};`,
    },
    bundle: true,
    outfile: path.join(temporary, 'fixture.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'count-response-renders-in-test-bundle',
        setup(builder) {
          builder.onLoad({ filter: /\/src\/chat\.tsx$/ }, async ({ path: file }) => {
            const source = await fs.readFile(file, 'utf8');
            const marker = 'const [activityOpen, setActivityOpen] = useState(false);';
            assert.ok(source.includes(marker), 'response render instrumentation anchor exists');
            return {
              contents: source.replace(
                marker,
                `${marker}\n    window.__renderCounts[entry.id === 'live-answer' ? 'active' : 'history']++;`,
              ),
              loader: 'tsx',
            };
          });
        },
      },
    ],
  });
  const js = await fs.readFile(path.join(temporary, 'fixture.js'));
  server = http.createServer((request, response) => {
    response.setHeader(
      'Content-Type',
      request.url === '/fixture.js' ? 'text/javascript' : 'text/html',
    );
    response.end(
      request.url === '/fixture.js'
        ? js
        : '<!doctype html><div id="root"></div><script src="/fixture.js"></script>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.measure === 'function');
  const baseline = await page.evaluate(() => window.measure(false));
  const shared = await page.evaluate(() => window.measure(true));
  assert.equal(baseline.history, baseline.turns * baseline.updates);
  assert.equal(shared.history, 0, 'streaming must not rerender completed turns');
  assert.equal(shared.active, shared.updates, 'every streamed update remains visible');
  assert.equal(shared.retainedMessages, shared.turns * 2 + 1);
  assert.equal(shared.hiddenToolRows, 0, 'closed activity must not mount hidden tool rows');
  const activity = page.locator('.response-work').first();
  await activity.locator('summary').click();
  await activity.locator('.tool.step').waitFor({ state: 'visible' });
  assert.match(await activity.innerText(), /Inspecting files 0/);
  await activity.locator('summary').click();
  await activity.locator('.tool.step').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ baseline, shared }, null, 2));
  console.log(
    'PASS: stable historical rows, every streamed update visible, activity details mount only when opened.',
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(temporary, { recursive: true, force: true });
}
