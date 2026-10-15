import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { Store } from '../electron/store';
import { actionSchema } from '../electron/core';
import { accountCardStyle } from '../src/account-color';

test('account colors persist independently and reset without changing chats or accounts', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-account-colors-')));
  const m = new Manager(root, () => {});
  try {
    const a = m.addAccount('claude', 'Personal');
    const b = m.addAccount('codex', 'Trabajo');
    m.state.projects.push({ id: 'p', name: 'Project', path: root });
    const session = m.newSession('p', a.id);
    m.setAccountColor(a.id, '#193652');
    m.setAccountColor(b.id, '#E6C98B');
    const restored = new Store(root);
    assert.equal(restored.state.profiles?.find((p) => p.id === a.id)?.color, '#193652');
    assert.equal(restored.state.profiles?.find((p) => p.id === b.id)?.color, '#e6c98b');
    assert.equal(m.state.sessions.find((s) => s.id === session.id)?.profile, a.id);
    assert.throws(() => m.setAccountColor(a.id, 'red'));
    assert.throws(() => m.setAccountColor('claude-999', '#ffffff'));
    m.setAccountColor(a.id, null);
    assert.equal(new Store(root).state.profiles?.find((p) => p.id === a.id)?.color, undefined);
    assert.equal(new Store(root).state.profiles?.find((p) => p.id === b.id)?.color, '#e6c98b');
  } finally {
    await m.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('color and Chrome actions accept bounded data, not arbitrary URLs or CSS', () => {
  for (const color of ['#193652', '#E6C98B', null])
    assert.ok(actionSchema.safeParse({ type: 'setAccountColor', profile: 'codex', color }).success);
  for (const color of ['red', '#fff', 'url(https://example.com)', 'var(--text)'])
    assert.ok(
      !actionSchema.safeParse({ type: 'setAccountColor', profile: 'codex', color }).success,
    );
  assert.ok(
    actionSchema.safeParse({ type: 'openDevInChrome', sessionId: 's', port: 5173 }).success,
  );
  for (const port of [0, 65536, 1.5])
    assert.ok(!actionSchema.safeParse({ type: 'openDevInChrome', sessionId: 's', port }).success);
  assert.ok(
    !actionSchema.safeParse({
      type: 'openDevInChrome',
      sessionId: 's',
      port: 3000,
      url: 'https://example.com',
    }).success,
  );
});
test('card colors retain chosen backgrounds and select readable text for light and dark colors', () => {
  assert.equal(accountCardStyle('#193652')?.backgroundColor, '#193652');
  assert.equal((accountCardStyle('#193652') as any)['--text'], '#ffffff');
  assert.equal((accountCardStyle('#e6c98b') as any)['--text'], '#161616');
  assert.equal(accountCardStyle('red'), undefined);
  assert.equal(accountCardStyle(), undefined);
});

test('subdued message text retains contrast on custom backgrounds', () => {
  const luminance = (rgb: number[]) =>
    rgb
      .map((n) => {
        const v = n / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (const color of [
    '#00171b',
    '#193652',
    '#e6c98b',
    '#777777',
    '#7f7f7f',
    '#ffffff',
    '#000000',
  ]) {
    const style = accountCardStyle(color) as Record<string, string>;
    const raw = style['--multichat-body'];
    const rgb = raw.startsWith('#')
      ? [1, 3, 5].map((i) => parseInt(raw.slice(i, i + 2), 16))
      : raw.match(/\d+/g)!.map(Number);
    const a = luminance(rgb),
      b = luminance([1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)));
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, color);
  }
});
