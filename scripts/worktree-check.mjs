// Worktree isolation end to end in a temporary repository. No model calls, no existing projects.
// Optional: with Claude Code installed, opens an isolated chat for real (initialization only).
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
const output = path.resolve('dist-electron/worktree-check.cjs');
await build({
  stdin: {
    loader: 'ts',
    resolveDir: process.cwd(),
    contents: `
import {Manager} from './electron/manager';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
const step=(text:string)=>console.log('✓',text);
(async()=>{
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'agent-desk-worktrees-')));
const repo=path.join(root,'repo');fs.mkdirSync(repo);
git(repo,'init','-b','main');
git(repo,'config','user.name','Agent Desk Check');git(repo,'config','user.email','check@example.invalid');
git(repo,'config','commit.gpgsign','false');git(repo,'config','core.hooksPath','/dev/null');
fs.writeFileSync(path.join(repo,'.gitignore'),'node_modules/\\n');
fs.writeFileSync(path.join(repo,'shared.txt'),'base\\n');
fs.mkdirSync(path.join(repo,'node_modules','pkg'),{recursive:true});
git(repo,'add','.');git(repo,'commit','-m','inicio');
const manager=new Manager(path.join(root,'data'),()=>{});
try{
  manager.addAccount('claude','Claude 1');manager.addAccount('claude','Claude 2');
  const project=await manager.addProject(repo);
  const first=manager.session(manager.state.selectedSession!);
  const second=manager.newSession(project.id,'claude-2');
  // 1 · Default: a new chat isolates itself when another agent is alive in the project.
  first.status='ready';
  const cwd=await (manager as any).workspace(second,repo);
  first.status='stopped';
  const wt=second.worktree!;
  assert.ok(wt && cwd===wt.cwd && fs.existsSync(path.join(wt.path,'.git')));
  assert.equal(git(wt.path,'rev-parse','--abbrev-ref','HEAD'),wt.branch);
  assert.ok(fs.lstatSync(path.join(wt.path,'node_modules')).isSymbolicLink());
  assert.equal(git(wt.path,'status','--porcelain'),'');
  assert.equal(git(repo,'status','--porcelain'),'');
  step('creación: '+wt.branch+' desde '+wt.base+' fuera del proyecto, node_modules enlazado');
  // 2 · Merge with automatic commit.
  fs.writeFileSync(path.join(wt.path,'feature.txt'),'agente\\n');
  const diff=await manager.diff(project.id,second.id);
  assert.equal(diff.worktree?.dirty,1);
  assert.equal(diff.files[0]?.path,'feature.txt');
  const merged=await manager.worktree(second.id,'merge');
  assert.equal(merged.merged,true,merged.message);
  assert.equal(fs.readFileSync(path.join(repo,'feature.txt'),'utf8'),'agente\\n');
  step('fusión limpia en main: '+merged.message);
  // 3 · Conflict detection never touches the main checkout.
  fs.writeFileSync(path.join(repo,'shared.txt'),'principal\\n');git(repo,'commit','-am','principal');
  fs.writeFileSync(path.join(wt.path,'shared.txt'),'agente\\n');
  const head=git(repo,'rev-parse','HEAD');
  const conflict=await manager.worktree(second.id,'merge');
  assert.deepEqual(conflict.conflicts,['shared.txt']);
  assert.equal(git(repo,'rev-parse','HEAD'),head);
  assert.equal(git(repo,'status','--porcelain'),'');
  step('conflicto detectado sin modificar la copia principal');
  const update=await manager.worktree(second.id,'update');
  assert.deepEqual(update.conflicts,['shared.txt']);
  fs.writeFileSync(path.join(wt.path,'shared.txt'),'resuelto\\n');
  git(wt.path,'commit','-am','resuelve');
  assert.equal((await manager.worktree(second.id,'merge')).merged,true);
  assert.equal(fs.readFileSync(path.join(repo,'shared.txt'),'utf8'),'resuelto\\n');
  step('conflicto llevado al worktree, resuelto y fusionado');
  // 4 · Duplicate the chat into another worktree that starts from the same files.
  second.attempted=true;
  fs.writeFileSync(path.join(wt.path,'idea.txt'),'enfoque A\\n');
  const fork=await manager.fork(second.id,true);
  assert.equal(fork.forkFrom,second.reference);
  assert.notEqual(fork.worktree!.path,wt.path);
  assert.equal(fs.readFileSync(path.join(fork.worktree!.path,'idea.txt'),'utf8'),'enfoque A\\n');
  assert.equal(fork.worktree!.base,'main');
  step('duplicado en '+fork.worktree!.branch+' con el mismo punto de partida');
  // 5 · Discard removes checkout and branch.
  for(const s of [fork,second]){
    const {path:checkout,branch}=s.worktree!;
    await manager.worktree(s.id,'discard');
    assert.equal(s.worktree,undefined);
    assert.equal(fs.existsSync(checkout),false);
    assert.equal(git(repo,'branch','--list',branch),'');
  }
  assert.equal(git(repo,'worktree','list','--porcelain').split('\\n').filter(l=>l.startsWith('worktree ')).length,1);
  step('descartados: carpetas y ramas eliminadas');
  // 6 · Optional: a real Claude Code process starts inside its worktree (no prompt is sent).
  await manager.discover();
  if(manager.state.tools.claude){
    const live=manager.newSession(project.id,'claude-1');
    manager.setIsolation(live.id,'worktree');
    await manager.start(live.id);
    assert.equal(live.status,'ready');
    assert.ok(live.worktree);
    await manager.runtimes.get(live.id)!.claude!.mcpStatus();
    assert.ok(live.info?.mcpServers.some((m:any)=>m.name==='agent_desk'&&m.status==='connected'));
    assert.equal(manager.coordinator.snapshot().some((a:any)=>a.sessionId===live.id),false);
    await manager.stop(live.id);
    await manager.worktree(live.id,'discard');
    step('Claude Code arranca en el worktree con MCP conectado y sin reservas compartidas');
  } else console.log('· Claude Code no encontrado: se omite el arranque real');
  console.log('worktree-check OK');
}finally{
  await manager.shutdown();
  fs.rmSync(root,{recursive:true,force:true});
}
})().catch(e=>{console.error(e);process.exit(1)});
`,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  external: ['electron', 'node-pty', '@anthropic-ai/claude-agent-sdk'],
  logLevel: 'warning',
});
const child = spawn(electron, [output], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
