import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AntigravityRuntime,
  antigravityAccount,
  antigravityModels,
  connectAntigravity,
  disconnectAntigravity,
  linkedAntigravity,
} from '../electron/antigravity';
import { Accounts } from '../electron/accounts';
import { stepFromMessage } from '../src/activity';
import { Store } from '../electron/store';
import { Manager } from '../electron/manager';
import { antigravityPermissionNeeded } from '../src/antigravity-permissions';
import type { Session } from '../src/shared';
export const fakeAgy = `#!/usr/bin/env node
const fs=require('fs'),rl=require('readline');
const args=process.argv.slice(2);const send=v=>console.log(JSON.stringify(v));
if(args.includes('models'))console.log('gemini-fixture-low\\tGemini Fixture Low\\nclaude-fixture\\tClaude');
else if(args.includes('/usage'))send({status:'SUCCESS',command:{name:'usage',data:{groups:[]}}});
else if(args.includes('--input-format')) {
 if(args.includes('--dangerously-skip-permissions'))process.exit(9);
 const resumed=args.includes('--conversation');
 const input=rl.createInterface({input:process.stdin});
 input.on('line',line=>{const m=JSON.parse(line);
 send({event:'init',conversation_id:'fixture-conversation'});
 if(m.message.content==='hang')return;
 if(m.message.content==='broken'){process.exit(0);return;}
 if(m.message.content==='denied'){
 send({event:'step_update',step_update:{step_type:'tool',step_index:1,state:'ACTIVE',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'ls fixture'},error:{type:'TOOL_ERROR',message:'permission check failed: user denied permission'}}}});
 send({event:'step_update',step_update:{step_type:'tool',step_index:1,state:'DONE'}});
 send({event:'result',result:{conversation_id:'fixture-conversation',status:'SUCCESS',response:''}});return;
 }
 if(m.message.content==='unfinished-tool'){
 send({event:'step_update',step_update:{step_type:'tool',step_index:2,state:'ACTIVE',tool_name:'read_file'}});
 process.exit(0);return;
 }
 send({event:'step_update',step_update:{step_type:'agent_response',state:'ACTIVE',text_delta:'Hola'}});
 send({event:'result',result:{conversation_id:'fixture-conversation',status:'SUCCESS',response:resumed?'Respuesta reanudada':'Hola Gemini',usage:{input_tokens:resumed?150:100,output_tokens:resumed?20:10,thinking_tokens:2}}});
 });input.on('close',()=>process.exit(0));
} else {console.log('Terminal Antigravity fixture.');setInterval(()=>{},1000);}
`;
async function fixture(run: (root: string, binary: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-agy-test-')));
  const binary = path.join(root, 'agy');
  await fs.writeFile(binary, fakeAgy, { mode: 0o700 });
  try {
    await run(root, binary);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const session = (): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'gemini-1',
  title: 'Gemini',
  status: 'stopped',
  messages: [],
  approvals: [],
});
test('permission recovery is scoped to the latest Gemini turn and survives a saved handoff', () => {
  const s = session();
  s.reference = 'agy:fixture';
  s.messages = [
    { id: 'user', role: 'user', text: 'Tarea' },
    {
      id: 'agy-tool:blocked',
      role: 'tool',
      text: '',
      tool: { kind: 'command', status: 'declined', command: 'ls' },
    },
  ];
  assert.equal(antigravityPermissionNeeded(s), true);
  s.messages.push({ id: 'agy-handoff:1', role: 'system', kind: 'info', text: 'En el panel' });
  assert.equal(antigravityPermissionNeeded(s), false);
  s.messages.push({ id: 'user2', role: 'user', text: 'Otra tarea' });
  s.messages.push({
    id: 'agy-tool:legacy',
    role: 'tool',
    text: '',
    tool: { kind: 'command', status: 'failed', output: 'permission check failed' },
  });
  assert.equal(antigravityPermissionNeeded(s), true);
  s.reference = 'other';
  assert.equal(antigravityPermissionNeeded(s), false);
});
test('permission handoff cannot interrupt active turns and restores chat mode if startup fails', () =>
  fixture(async (root, binary) => {
    const manager = new Manager(root, () => {});
    manager.state.tools.gemini = binary;
    manager.state.profiles = [{ id: 'gemini-1', kind: 'gemini', name: 'Fixture' }];
    manager.accounts.register('gemini-1');
    manager.state.projects = [{ id: 'p', name: 'Fixture', path: root }];
    const s = session();
    s.reference = 'agy:fixture';
    s.mode = 'chat';
    s.status = 'working';
    manager.state.sessions = [s];
    try {
      await assert.rejects(manager.continueAntigravity('s'), /termine el turno/);
      assert.equal(s.mode, 'chat');
      s.status = 'ready';
      await assert.rejects(manager.continueAntigravity('s'), /Vincula tu cuenta/);
      assert.equal(s.mode, 'chat');
      assert.equal(s.reference, 'agy:fixture');
      assert.equal(manager.runtimes.size, 0);
      assert.equal(s.messages.length, 0);
    } finally {
      await manager.shutdown();
    }
  }));
async function until(fn: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('timeout');
}
test('Antigravity binds one local profile, verifies access, and only unlinks Agent Desk', () =>
  fixture(async (root, binary) => {
    assert.equal((await antigravityAccount(root, 'gemini-1', binary, {})).status, 'signedOut');
    const results = await Promise.allSettled(
      ['gemini-1', 'gemini-2'].map((profile) =>
        connectAntigravity(root, profile as any, binary, {}),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const owner = (await linkedAntigravity(root))!;
    assert.equal((await antigravityAccount(root, owner, binary, {})).status, 'signedIn');
    const accounts = new Accounts(
      root,
      () => ({ gemini: binary }),
      () => {},
      () => {},
      async () => {},
    );
    accounts.register(owner);
    await accounts.refresh(owner);
    assert.equal(accounts.state[owner].status, 'signedIn');
    assert.deepEqual(
      (await accounts.readModels(owner, new AbortController().signal)).map((m) => m.value),
      ['gemini-fixture-low'],
    );
    await disconnectAntigravity(root, owner === 'gemini-1' ? 'gemini-2' : 'gemini-1');
    assert.equal(await linkedAntigravity(root), owner);
    await accounts.logout(owner, false);
    assert.equal(await linkedAntigravity(root), undefined);
    await accounts.shutdown();
  }));
test('native Gemini streams, resumes, tracks cumulative tokens, and stops incomplete turns', () =>
  fixture(async (root, binary) => {
    const s = session(),
      rt = new AntigravityRuntime(s, binary, root, {}, () => {});
    try {
      await rt.start();
      assert.equal(s.info!.models.length, 1);
      await rt.send('Hola', []);
      await until(() => s.status === 'ready');
      assert.equal(s.reference, 'agy:fixture-conversation');
      assert.equal(s.messages.at(-1)?.text, 'Hola Gemini');
      assert.equal(s.stats?.inputTokens, 100);
      assert.equal(s.stats?.outputTokens, 12);
      await rt.send('Continúa', []);
      await until(() => s.status === 'ready');
      assert.equal(s.messages.at(-1)?.text, 'Respuesta reanudada');
      assert.equal(s.stats?.inputTokens, 150);
      await rt.send('hang', []);
      await rt.interrupt();
      assert.equal(s.status, 'ready');
      await rt.send('broken', []);
      await until(() => s.status === 'error');
      assert.match(s.error!, /sin completar/);
    } finally {
      await rt.stop();
    }
  }));
test('legacy Gemini history and unsupported attachments are not silently dropped', () =>
  fixture(async (root, binary) => {
    const s = { ...session(), attempted: true, reference: 'old-acp-session' };
    const rt = new AntigravityRuntime(s, binary, root, {}, () => {});
    await assert.rejects(rt.start(), /historial anterior se conserva/);
    s.attempted = false;
    s.reference = '';
    await rt.start();
    await assert.rejects(rt.send('archivo', [{} as any]), /admite texto/);
    assert.equal(s.messages.length, 0);
    assert.equal((await antigravityModels(binary, {}))[0].image, false);
  }));
test('Gemini permission rejection is visible and never remains running, including resumed turns', () =>
  fixture(async (root, binary) => {
    const s = session(),
      rt = new AntigravityRuntime(s, binary, root, {}, () => {});
    await rt.start();
    for (let i = 0; i < 2; i++) {
      await rt.send('denied', []);
      await until(() => s.status === 'ready');
    }
    const tools = s.messages.filter((m) => m.role === 'tool');
    assert.equal(tools.length, 2);
    assert.notEqual(tools[0].id, tools[1].id);
    assert.equal(tools[0].tool?.status, 'declined');
    assert.equal(stepFromMessage(tools[0]).label, 'ls fixture');
    assert.equal(stepFromMessage(tools[0]).running, false);
    assert.match(s.messages.at(-1)!.text, /continúa.*permiso/);
    await rt.send('unfinished-tool', []);
    await until(() => s.status === 'error');
    assert.equal(s.messages.at(-1)?.tool?.status, 'failed');
    const generic = {
      ...tools[0],
      tool: { kind: 'mcp' as const, tool: 'list_files', status: 'completed' },
    };
    assert.equal(stepFromMessage(generic).label, 'list_files');
    await rt.stop();
    const store = new Store(root);
    store.state.profiles = [{ id: 'gemini-1', kind: 'gemini', name: 'Google' }];
    store.state.projects = [{ id: 'p', name: 'Fixture', path: root }];
    store.state.sessions = [
      { ...s, messages: [{ ...generic, tool: { ...generic.tool, status: 'inProgress' } }] },
    ];
    store.flush();
    assert.equal(new Store(root).state.sessions[0].messages[0].tool?.status, 'failed');
  }));
