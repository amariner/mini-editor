import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCodexEvent } from '../electron/codex-events';
import { applyClaudeMessage } from '../electron/claude-events';
import { reportedTokens, signatureModel, compactTokens } from '../src/task-signature';
import { defaultOptimization, type Session } from '../src/shared';

const session = (profile: Session['profile'] = 'codex'): Session => ({
  id: 's',
  projectId: 'p',
  profile,
  reference: 'thread-a',
  title: 'Tarea',
  status: 'ready',
  messages: [],
  approvals: [],
});
test('los totales de Codex reemplazan lecturas repetidas sin sumar caché ni razonamiento dos veces', () => {
  const s = session();
  const event = {
    threadId: 'thread-a',
    turnId: 't',
    tokenUsage: {
      total: {
        inputTokens: 1234,
        cachedInputTokens: 1000,
        outputTokens: 340,
        reasoningOutputTokens: 200,
      },
      last: { inputTokens: 200, outputTokens: 100 },
    },
  };
  assert.equal(reportedTokens(s), undefined);
  applyCodexEvent(s, 'thread/tokenUsage/updated', { ...event, threadId: 'other' });
  assert.equal(reportedTokens(s), undefined);
  applyCodexEvent(s, 'thread/tokenUsage/updated', event);
  applyCodexEvent(s, 'thread/tokenUsage/updated', event);
  assert.deepEqual(reportedTokens(s), { input: 1234, output: 340 });
  for (const inputTokens of [-1, NaN, '500', undefined]) {
    applyCodexEvent(s, 'thread/tokenUsage/updated', {
      ...event,
      tokenUsage: { total: { inputTokens, outputTokens: 0 } },
    });
  }
  assert.deepEqual(reportedTokens(s), { input: 1234, output: 340 });
  event.tokenUsage.total.inputTokens = 1400;
  applyCodexEvent(s, 'thread/tokenUsage/updated', event);
  assert.equal(reportedTokens(s)?.input, 1400);
});
test('Claude muestra cifras confirmadas al terminar, con caché y sin inventar lecturas de contexto', () => {
  const s = session('claude-1');
  s.stats = {
    cost: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    contextTokens: 900,
  };
  assert.equal(reportedTokens(s), undefined);
  const result = {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
    },
  };
  applyClaudeMessage(s, result);
  assert.deepEqual(reportedTokens(s), { input: 350, output: 40 });
  applyClaudeMessage(s, result);
  assert.deepEqual(reportedTokens(s), { input: 700, output: 80 });
  assert.equal(compactTokens(1234), '1,2k');
  assert.equal(compactTokens(340), '340');
  assert.equal(compactTokens(1200000), '1,2M');
});
test('Auto espera al envío, mantiene la tarea activa y deja elegir el siguiente modelo manual', () => {
  const s = session();
  const auto = { ...defaultOptimization, autoModel: true };
  assert.equal(signatureModel(s, auto, false), 'Auto');
  s.optimization = { model: 'modelo-a', autoModel: true, level: 0, reason: 'Normal' };
  assert.equal(signatureModel(s, auto, false), 'modelo-a');
  assert.equal(signatureModel(s, auto, true), 'Auto');
  s.codexConfig = { model: 'modelo-b' } as Session['codexConfig'];
  s.status = 'working';
  assert.equal(signatureModel(s, auto, true), 'modelo-a');
  assert.equal(signatureModel(s, defaultOptimization, true), 'modelo-a');
  s.turnId = 't';
  applyCodexEvent(s, 'model/rerouted', { threadId: 'thread-a', turnId: 'old', toModel: 'ignored' });
  assert.equal(signatureModel(s, auto, true), 'modelo-a');
  applyCodexEvent(s, 'model/rerouted', { threadId: 'thread-a', turnId: 't', toModel: 'modelo-c' });
  assert.equal(signatureModel(s, auto, true), 'modelo-c');
  s.status = 'ready';
  assert.equal(signatureModel(s, defaultOptimization, true), 'modelo-b');
});
