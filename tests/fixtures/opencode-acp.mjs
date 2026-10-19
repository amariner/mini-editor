#!/usr/bin/env node
// Local ACP protocol fixture: no network, credentials, or model calls.
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
const sessionId = 'ses_fixture';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result = {}) => send({ id, result });
const options = [
  { id: 'model', options: [{ value: 'opencode/free-model' }, { value: 'opencode/paid-model' }] },
];
let promptID, permissionID;
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const event = JSON.parse(line),
    p = event.params;
  if (event.method === 'initialize')
    return reply(event.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  if (['session/new', 'session/load'].includes(event.method))
    return reply(event.id, { sessionId, configOptions: options });
  if (event.method === 'session/set_config_option') {
    await fs.appendFile(
      path.join(process.cwd(), 'trace.jsonl'),
      JSON.stringify({ model: p.value }) + '\n',
    );
    return reply(event.id, { configOptions: options });
  }
  if (event.method === 'session/cancel') {
    if (promptID !== undefined) reply(promptID, { stopReason: 'cancelled' });
    promptID = undefined;
    permissionID = undefined;
    return;
  }
  if (event.method === 'session/prompt') {
    promptID = event.id;
    const text = p.prompt.map((c) => c.text ?? '').join('\n');
    if (text.includes('write')) {
      permissionID = 77;
      send({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'write-1',
            title: 'Write test.txt',
            status: 'pending',
          },
        },
      });
      send({
        id: permissionID,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            title: 'Write test.txt',
            content: [{ type: 'diff', path: 'test.txt', newText: 'approved' }],
          },
          options: [
            { optionId: 'once', kind: 'allow_once' },
            { optionId: 'always', kind: 'allow_always' },
            { optionId: 'reject', kind: 'reject_once' },
          ],
        },
      });
      return;
    }
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } },
      },
    });
    if (text.includes('slow')) return;
    reply(event.id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 } });
    promptID = undefined;
    return;
  }
  if (event.id === permissionID && !event.method) {
    if (promptID === undefined) return;
    if (event.result.outcome.optionId === 'once')
      await fs.writeFile(path.join(process.cwd(), 'test.txt'), 'approved');
    send({
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          status: event.result.outcome.optionId === 'reject' ? 'failed' : 'completed',
        },
      },
    });
    reply(promptID, { stopReason: 'end_turn' });
    promptID = undefined;
    permissionID = undefined;
  }
});
