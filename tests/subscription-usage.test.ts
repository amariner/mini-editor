import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexUsage,
  claudeUsage,
  limitingWindow,
  currentUsageWindow,
  resetCountdown,
} from '../src/subscription-usage';
const now = Date.parse('2026-10-06T12:00:00Z');
test('normaliza unidades oficiales sin sumar cuotas ni confundir fracciones con porcentajes', () => {
  const c = codexUsage(
    {
      rateLimits: {
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
        secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: now / 1000 + 7200 },
      },
    },
    now,
  );
  assert.equal(c.windows[0].usedPercent, 1);
  assert.equal(c.windows[0].resetsAt, now + 3600000);
  const a = claudeUsage(
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 1, resets_at: new Date(now + 3600000).toISOString() },
        seven_day: { utilization: 80, resets_at: new Date(now + 7200000).toISOString() },
      },
    },
    now,
  );
  assert.deepEqual(c.windows, a.windows);
  assert.equal(limitingWindow(c, now)?.usedPercent, 80);
  assert.equal(resetCountdown(c.windows[0].resetsAt, now), 'Reinicio en 1h 0m');
});
test('datos nulos, caducados o reinicios pasados no se presentan como cuota libre', () => {
  assert.equal(
    codexUsage({ rateLimits: { primary: { usedPercent: null } } }, now).windows.length,
    0,
  );
  assert.equal(
    claudeUsage(
      { rate_limits_available: false, rate_limits: { five_hour: { utilization: 50 } } },
      now,
    ).windows.length,
    0,
  );
  const u = codexUsage(
    { rateLimits: { primary: { usedPercent: 90, resetsAt: now / 1000 + 1 } } },
    now,
  );
  assert.equal(limitingWindow(u, now + 1001), undefined);
  assert.equal(limitingWindow({ ...u, checkedAt: now - 200000 }, now), undefined);
});
test('prefiere cuota Codex general y no mezcla buckets de productos diferentes', () => {
  const b = { primary: { usedPercent: 20 } };
  assert.equal(
    codexUsage({ rateLimitsByLimitId: { codex: b, other: { primary: { usedPercent: 99 } } } })
      .windows[0].usedPercent,
    20,
  );
  assert.equal(codexUsage({ rateLimitsByLimitId: { a: b, b: b } }).windows.length, 0);
});

test('cada cuota caduca por separado y la cuota de apps no sustituye a la semanal general', () => {
  const usage = {
    checkedAt: now,
    windows: [
      { label: '5 h', usedPercent: 37, resetsAt: now + 1000 },
      { label: '7 días', usedPercent: 81, resetsAt: now + 86400000 },
      { label: '7 días · apps', usedPercent: 99, resetsAt: now + 86400000 },
    ],
  };
  assert.equal(currentUsageWindow(usage, '5 h', now + 1001), undefined);
  assert.equal(currentUsageWindow(usage, '7 días', now + 1001)?.usedPercent, 81);
  assert.equal(currentUsageWindow(usage, '7 días', now + 180001), undefined);
});
test('el selector muestra ambas cuotas y la renovación de Claude a 5h o de Codex semanal', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { UsageSwitcher } = await import('../src/usage-switcher');
  const props = {
    profiles: [{ id: 'codex' as const, name: 'Codex', kind: 'codex' as const }],
    profile: 'codex' as const,
    disabled: false,
    change: () => {},
  };
  const markup = renderToStaticMarkup(
    React.createElement(UsageSwitcher, {
      ...props,
      usage: {
        checkedAt: Date.now(),
        windows: [
          { label: '5 h', usedPercent: 37, resetsAt: Date.now() + 3600000 },
          { label: '7 días', usedPercent: 81, resetsAt: Date.now() + 86400000 },
        ],
      },
    }),
  );
  assert.match(markup, /width:37%/);
  assert.match(markup, /Consumo 5 horas: 37%/);
  assert.match(markup, /Consumo semanal: 81%/);
  assert.match(markup, /Renovación semanal: en 1d 0m/);
  assert.doesNotMatch(markup, /usado|Reinicio en|Sin sesión|Plan no disponible/);
  const claude = renderToStaticMarkup(
    React.createElement(UsageSwitcher, {
      ...props,
      profiles: [{ id: 'claude-1', name: 'Personal', kind: 'claude' }],
      profile: 'claude-1',
      usage: {
        checkedAt: Date.now(),
        windows: [
          { label: '5 h', usedPercent: 37, resetsAt: Date.now() + 3600000 },
          { label: '7 días', usedPercent: 81, resetsAt: Date.now() + 86400000 },
        ],
      },
    }),
  );
  assert.match(claude, /Renovación de 5 horas: en 1h 0m/);
  const empty = renderToStaticMarkup(React.createElement(UsageSwitcher, props));
  assert.doesNotMatch(empty, /usage-fill/);
  assert.match(empty, /Consumo 5 horas: no disponible/);
  assert.match(empty, /Consumo semanal: no disponible/);
  assert.match(empty, /Renovación semanal: no disponible/);
});
