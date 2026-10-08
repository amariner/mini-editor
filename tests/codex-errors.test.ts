import test from 'node:test';
import assert from 'node:assert/strict';
import { codexRpcError } from '../electron/codex-errors';

test('los fallos de conexión no se presentan como sesión cerrada o versión incompatible', () => {
  for (const message of [
    'workspace routing discovery failed',
    'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)',
  ]) {
    const error = codexRpcError(message, -32603);
    assert.match(error.message, /conectar con ChatGPT/);
    assert.match(error.message, /proxy/);
    assert.doesNotMatch(error.message, /versión|https:\/\//);
  }
});

test('solo method-not-found indica una función incompatible; conserva otros errores RPC', () => {
  assert.match(codexRpcError('Method not found', -32601).message, /versión/);
  assert.equal(codexRpcError('Invalid params', -32602).message, 'Invalid params (RPC -32602).');
});
