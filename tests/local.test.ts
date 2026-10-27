import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalService, localModelName, LocalMemoryGuard, localSwapUsed } from '../electron/local';
import { actionSchema } from '../electron/core';
import { Manager } from '../electron/manager';
import { routerStream } from '../electron/openrouter';

async function fixture(run: (service: LocalService, root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-local-')));
  const service = new LocalService(root, {}, async () => 1);
  try {
    await run(service, root);
  } finally {
    await service.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
}
test('local catalog persists folder selection, excludes directories/projectors and rejects traversal', () =>
  fixture(async (service, root) => {
    const folder = path.join(root, 'models');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'Qwen.gguf'), 'GGUFfixture');
    await fs.writeFile(path.join(folder, 'mmproj-Qwen.gguf'), 'GGUFfixture');
    await fs.mkdir(path.join(folder, 'directory.gguf'));
    await fs.symlink(path.join(root, 'outside.gguf'), path.join(folder, 'link.gguf'));
    assert.equal(actionSchema.safeParse({ type: 'addAccount', kind: 'local' }).success, true);
    assert.equal(
      actionSchema.safeParse({
        type: 'localConfigure',
        profile: 'local-1',
        context: 999999,
        tools: false,
      }).success,
      false,
    );
    assert.throws(() => localModelName('../escape.gguf'));
    await service.configure('local-1', { directory: folder, tools: true });
    const restored = new LocalService(root);
    assert.equal((await restored.config('local-1')).directory, folder);
    assert.deepEqual(
      (await restored.catalog('local-1')).map((m) => [m.value, m.tools, m.image]),
      [['Qwen.gguf', true, false]],
    );
    await fs.writeFile(path.join(root, 'bad.gguf'), 'html');
    await assert.rejects(service.importModel('local-1', path.join(root, 'bad.gguf')), /no es GGUF/);
    await assert.rejects(
      service.downloadModel('local-1', 'https://example.com/model.gguf'),
      /Hugging Face/,
    );
    assert.equal((await service.status('local-1')).busy, undefined);
  }));
test('recursive catalog distinguishes identical filenames, skips invalid files and contains symlinks', () =>
  fixture(async (service, root) => {
    const directory = path.join(root, 'models');
    for (const folder of ['vendor/a', 'vendor/b', 'snapshots/revision', 'blobs'])
      await fs.mkdir(path.join(directory, folder), { recursive: true });
    for (const name of [
      'vendor/a/model.gguf',
      'vendor/b/model.gguf',
      'vendor/a/mmproj-model.gguf',
      'blobs/hash',
    ])
      await fs.writeFile(path.join(directory, name), 'GGUFfixture');
    await fs.writeFile(path.join(directory, 'vendor/a/broken.gguf'), 'html');
    await fs.writeFile(path.join(root, 'outside.gguf'), 'GGUFfixture');
    await fs.symlink(path.join(root, 'outside.gguf'), path.join(directory, 'outside.gguf'));
    await fs.symlink(directory, path.join(directory, 'vendor/a/loop'));
    await fs.symlink('../../blobs/hash', path.join(directory, 'snapshots/revision/cached.gguf'));
    await service.configure('local-1', { directory });
    const catalog = await service.catalog('local-1');
    assert.deepEqual(
      catalog.map((model) => model.value),
      ['snapshots/revision/cached.gguf', 'vendor/a/model.gguf', 'vendor/b/model.gguf'],
    );
    assert.equal(new Set(catalog.map((model) => model.displayName)).size, 3);
    await service.configure('local-1', { defaultModel: 'vendor/b/model.gguf' });
    assert.equal((await new LocalService(root).catalog('local-1'))[0].value, 'vendor/b/model.gguf');
    await service.importModel('local-1', path.join(directory, 'vendor/a/model.gguf'));
    await assert.rejects(fs.stat(path.join(directory, 'model.gguf')), /ENOENT/);
    await service.removeModel('local-1', 'snapshots/revision/cached.gguf', fs.unlink);
    assert.equal(await fs.readFile(path.join(directory, 'blobs/hash'), 'utf8'), 'GGUFfixture');
    await service.removeModel('local-1', 'vendor/b/model.gguf', fs.unlink);
    assert.equal((await service.config('local-1')).defaultModel, undefined);
    for (const name of [
      '../outside.gguf',
      '/outside.gguf',
      'a/../../outside.gguf',
      'a\\outside.gguf',
      'a//model.gguf',
      'a/./model.gguf',
      'C:/outside.gguf',
      'a/\0model.gguf',
    ])
      assert.throws(() => localModelName(name));
    await assert.rejects(
      service.removeModel('local-1', 'outside.gguf', fs.unlink),
      /fuera de la carpeta/,
    );
    await assert.rejects(
      service.configure('local-1', { defaultModel: 'outside.gguf' }),
      /no está en la carpeta/,
    );
    await assert.rejects(
      service.configure('local-1', { defaultModel: 'vendor/a/broken.gguf' }),
      /no está en la carpeta/,
    );
    await assert.rejects(service.catalog('local-1', AbortSignal.abort()));
    const longName = `${'directory/'.repeat(24)}model.gguf`;
    assert.equal(localModelName(longName), longName);
    assert.equal(
      actionSchema.safeParse({
        type: 'localConfigure',
        profile: 'local-1',
        context: 8192,
        tools: false,
        defaultModel: longName,
      }).success,
      true,
    );
  }));

test('split models are catalogued once when complete, imported together and removed together', () =>
  fixture(async (service, root) => {
    const directory = path.join(root, 'models'),
      source = path.join(root, 'source');
    await fs.mkdir(path.join(directory, 'family'), { recursive: true });
    await fs.mkdir(source);
    const first = 'family/model-00001-of-00002.gguf',
      second = 'family/model-00002-of-00002.gguf';
    await fs.writeFile(path.join(directory, first), 'GGUFfixture');
    await service.configure('local-1', { directory });
    assert.deepEqual(await service.catalog('local-1'), []);
    await fs.writeFile(path.join(directory, second), 'GGUFfixture');
    assert.deepEqual(
      (await service.catalog('local-1')).map((model) => model.value),
      [first],
    );
    await service.configure('local-1', { defaultModel: first });
    await service.removeModel('local-1', first, fs.unlink);
    assert.deepEqual(await fs.readdir(path.join(directory, 'family')), []);
    assert.equal((await service.config('local-1')).defaultModel, undefined);
    for (const name of [first, second])
      await fs.writeFile(path.join(source, path.basename(name)), 'GGUFfixture');
    await service.importModel('local-1', path.join(source, path.basename(first)));
    assert.deepEqual(
      (await service.catalog('local-1')).map((model) => model.value),
      [path.basename(first)],
    );
    await assert.rejects(
      service.importModel('local-1', path.join(source, path.basename(second))),
      /primera parte/,
    );
    // A conflict in a later part rolls back only files from this attempt.
    await fs.unlink(path.join(directory, path.basename(first)));
    await assert.rejects(
      service.importModel('local-1', path.join(source, path.basename(first))),
      /EEXIST/,
    );
    await assert.rejects(fs.stat(path.join(directory, path.basename(first))), /ENOENT/);
    assert.equal(
      await fs.readFile(path.join(directory, path.basename(second)), 'utf8'),
      'GGUFfixture',
    );
  }));
test('download validates GGUF, never overwrites an existing model, and cleans cancellation', () =>
  fixture(async (_service, root) => {
    const service = new LocalService(root, {
      fetch: async (_url, init) => {
        if (String(_url).includes('cancel'))
          return new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          );
        return new Response(String(_url).includes('bad') ? 'html' : 'GGUFdownload');
      },
    });
    await service.configure('local-1', { directory: root });
    const url = 'https://huggingface.co/test/model/resolve/main/model.gguf';
    await service.downloadModel('local-1', url);
    await assert.rejects(service.downloadModel('local-1', url), /EEXIST/);
    await assert.rejects(
      service.downloadModel('local-1', url.replace('model.gguf', 'bad.gguf')),
      /no es un modelo GGUF/,
    );
    const pending = service.downloadModel('local-1', url.replace('model.gguf', 'cancel.gguf'));
    await new Promise((r) => setTimeout(r, 20));
    service.cancelDownload();
    await assert.rejects(pending);
    assert.equal(
      (await fs.readdir(root)).some((name) => name.endsWith('.part')),
      false,
    );
    assert.equal(await fs.readFile(path.join(root, 'model.gguf'), 'utf8'), 'GGUFdownload');
    await service.shutdown();
  }));
test('cancelling before download starts never calls the transport or leaves the service busy', () =>
  fixture(async (_service, root) => {
    let requested = false;
    const service = new LocalService(root, {
      fetch: async () => {
        requested = true;
        return new Response('GGUFfixture');
      },
    });
    await service.configure('local-1', { directory: root });
    const pending = service.downloadModel(
      'local-1',
      'https://huggingface.co/test/model/resolve/main/cancel.gguf',
    );
    service.cancelDownload();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(requested, false);
    assert.equal(service.busy, false);
    assert.equal(
      (await fs.readdir(root)).some((name) => name.endsWith('.part') || name.endsWith('.gguf')),
      false,
    );
    await service.shutdown();
  }));

test('managed engine starts, authenticates, streams, rejects concurrent chats and stops', () =>
  fixture(async (service, root) => {
    const engine = path.join(root, 'local-engine', 'b11819');
    await fs.mkdir(engine, { recursive: true });
    const binary = path.join(engine, 'llama-server');
    await fs.writeFile(
      binary,
      `#!${process.execPath}\nconst http=require('node:http');const args=process.argv;const port=Number(args[args.indexOf('--port')+1]),key=args[args.indexOf('--api-key')+1];http.createServer((req,res)=>{if(req.url==='/health'){res.end('ok');return;}if(req.headers.authorization!=='Bearer '+key){res.writeHead(401);res.end();return;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'Local verificado'}}]})+'\\n\\n');setTimeout(()=>res.end('data: [DONE]\\n\\n'),100);}).listen(port,'127.0.0.1');`,
      { mode: 0o755 },
    );
    const model = 'family/variant/test.gguf';
    await fs.mkdir(path.dirname(path.join(root, model)), { recursive: true });
    await fs.writeFile(path.join(root, model), 'GGUFfixture');
    await service.configure('local-1', { directory: root });
    const request = () =>
      service.request('/chat/completions', 'local-1', {
        method: 'POST',
        body: JSON.stringify({ model, messages: [] }),
      });
    const response = await request();
    await assert.rejects(request(), /ocupado/);
    await assert.rejects(service.stopEngine(), /Espera/);
    const chunks = [];
    for await (const chunk of routerStream(response.body!, 'Local')) chunks.push(chunk);
    assert.equal(chunks[0].choices[0].delta.content, 'Local verificado');
    assert.equal((await service.status('local-1')).running, model);
    const controller = new AbortController();
    const aborted = await service.request('/chat/completions', 'local-1', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({ model, messages: [] }),
    });
    controller.abort();
    await aborted.body!.cancel().catch(() => {});
    await service.stopEngine();
    assert.equal((await service.status('local-1')).running, undefined);
  }));
test('local accounts restore and expose all folder models before starting chat', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desk-local-manager-')));
  const manager = new Manager(root, () => {});
  try {
    const account = manager.addAccount('local', 'Qwen local');
    assert.equal(account.id, 'local-1');
    manager.state.projects.push({ id: 'p', name: 'Project', path: root });
    await fs.writeFile(path.join(root, 'test.gguf'), 'GGUFfixture');
    await manager.accounts.local.configure(account.id, { directory: root });
    await manager.accounts.refresh(account.id);
    assert.equal(manager.accounts.state[account.id].status, 'signedIn');
    const session = manager.newSession('p', account.id);
    await manager.refreshModels(session.id);
    assert.equal(session.info?.models[0].value, 'test.gguf');
    await manager.configureProvider(session.id, { model: 'test.gguf' });
    assert.equal(session.providerConfig?.model, 'test.gguf');
    manager.store.flush();
    const { Store } = await import('../electron/store');
    assert.equal(new Store(root).state.profiles?.[0].kind, 'local');
  } finally {
    await manager.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('large contexts persist and enable quantized caches with a larger response budget', () =>
  fixture(async (service, root) => {
    for (const context of [65536, 131072]) {
      assert.equal(
        actionSchema.safeParse({ type: 'localConfigure', profile: 'local-1', context, tools: true })
          .success,
        true,
      );
      await service.configure('local-1', { context });
      assert.equal((await new LocalService(root).config('local-1')).context, context);
      assert.equal((await service.status('local-1')).outputLimit, 8192);
    }
    await assert.rejects(service.configure('local-1', { context: 262144 }), /contexto/);
    const engine = path.join(root, 'local-engine', 'b11819');
    await fs.mkdir(engine, { recursive: true });
    await fs.writeFile(
      path.join(engine, 'llama-server'),
      `#!${process.execPath}
const http=require('node:http'),fs=require('node:fs');const args=process.argv;
const option=name=>args[args.indexOf(name)+1];
fs.writeFileSync(${JSON.stringify(path.join(root, 'options.json'))},JSON.stringify({context:option('--ctx-size'),k:option('--cache-type-k'),v:option('--cache-type-v'),flash:option('--flash-attn')}));
http.createServer((req,res)=>{if(req.url==='/health'){res.end('ok');return;}let data='';req.on('data',c=>data+=c);req.on('end',()=>{fs.writeFileSync(${JSON.stringify(path.join(root, 'payload.json'))},data);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: [DONE]\\n\\n');});}).listen(Number(option('--port')),'127.0.0.1');`,
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(root, 'test.gguf'), 'GGUFfixture');
    await service.configure('local-1', { directory: root, context: 65536 });
    const response = await service.request('/chat/completions', 'local-1', {
      method: 'POST',
      body: JSON.stringify({ model: 'test.gguf', messages: [], stream: true }),
    });
    for await (const _chunk of routerStream(response.body!, 'Local')) {
      /* drain */
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'options.json'), 'utf8')), {
      context: '65536',
      k: 'q8_0',
      v: 'q8_0',
      flash: 'on',
    });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(root, 'payload.json'), 'utf8')).max_tokens,
      8192,
    );
    assert.equal((await service.status('local-1')).runningContext, 65536);
    await service.configure('local-1', { cacheType: 'q4_0' });
    assert.equal((await new LocalService(root).config('local-1')).cacheType, 'q4_0');
    const reduced = await service.request('/chat/completions', 'local-1', {
      method: 'POST',
      body: JSON.stringify({ model: 'test.gguf', messages: [], stream: true }),
    });
    for await (const _chunk of routerStream(reduced.body!, 'Local')) {
      /* drain */
    }
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'options.json'), 'utf8')).k, 'q4_0');
  }));

test('memory pressure prevents startup and stops a running generation with a useful error', () =>
  fixture(async (_service, root) => {
    let pressure = 4;
    const service = new LocalService(root, {}, async () => pressure);
    const engine = path.join(root, 'local-engine', 'b11819');
    await fs.mkdir(engine, { recursive: true });
    await fs.writeFile(
      path.join(engine, 'llama-server'),
      `#!${process.execPath}
const http=require('node:http');const args=process.argv;http.createServer((req,res)=>{if(req.url==='/health'){res.end('ok');return;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'Iniciando'}}]})+'\\n\\n');}).listen(Number(args[args.indexOf('--port')+1]),'127.0.0.1');`,
      { mode: 0o755 },
    );
    await fs.writeFile(path.join(root, 'test.gguf'), 'GGUFfixture');
    await service.configure('local-1', { directory: root });
    const request = () =>
      service.request('/chat/completions', 'local-1', {
        method: 'POST',
        body: JSON.stringify({ model: 'test.gguf', messages: [] }),
      });
    try {
      await assert.rejects(request(), /presión de memoria/);
      pressure = 1;
      const response = await request();
      pressure = 2;
      await new Promise((resolve) => setTimeout(resolve, 3500));
      assert.equal((await service.status('local-1')).running, 'test.gguf');
      pressure = 1;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      pressure = 4;
      await assert.rejects(async () => {
        for await (const _chunk of routerStream(response.body!, 'Local')) {
          /* drain */
        }
      }, /presión de memoria/);
      assert.equal((await service.status('local-1')).running, undefined);
      assert.equal(service.busy, false);
    } finally {
      await service.shutdown();
    }
  }));

test('default model survives restart, sorts first and clears when moved to trash', () =>
  fixture(async (service, root) => {
    await fs.writeFile(path.join(root, 'a.gguf'), 'GGUFfixture');
    await fs.writeFile(path.join(root, 'z.gguf'), 'GGUFfixture');
    await service.configure('local-1', { directory: root, defaultModel: 'z.gguf', context: 65536 });
    const restored = new LocalService(root);
    assert.equal((await restored.config('local-1')).defaultModel, 'z.gguf');
    assert.equal((await restored.catalog('local-1'))[0].value, 'z.gguf');
    assert.equal((await restored.catalog('local-1'))[0].isDefault, true);
    await service.removeModel('local-1', 'z.gguf', (file) => fs.unlink(file));
    assert.equal((await service.config('local-1')).defaultModel, undefined);
    await assert.rejects(
      service.configure('local-1', { defaultModel: 'missing.gguf' }),
      /no está en la carpeta/,
    );
  }));

test('memory guard tolerates transient warnings, resets after recovery and bounds sustained pressure', () => {
  const guard = new LocalMemoryGuard();
  assert.equal(guard.check(2, 0), undefined);
  assert.equal(guard.check(2, 3000), undefined);
  assert.equal(guard.check(2, 29999), undefined);
  assert.equal(guard.check(1, 30000), undefined);
  assert.equal(guard.check(2, 31000), undefined);
  assert.equal(guard.check(2, 60999), undefined);
  assert.equal(guard.check(2, 61000), 'sustained');
  assert.equal(new LocalMemoryGuard().check(4, 0), 'critical');
});

test('stable swap during a memory warning is allowed, rapid growth still stops the model', () => {
  const guard = new LocalMemoryGuard();
  const gib = 1024 ** 3;
  assert.equal(guard.check(2, 0, 4 * gib), undefined);
  assert.equal(guard.check(2, 30000, 4 * gib), undefined);
  assert.equal(guard.check(2, 60000, 4.1 * gib), undefined);
  assert.equal(guard.check(2, 90000, 5 * gib), 'sustained');
  assert.equal(guard.check(4, 90001, 5 * gib), 'critical');
});

test('swap telemetry reads used memory rather than the total allocation', () => {
  assert.equal(
    localSwapUsed('total = 5120.00M used = 3667.25M free = 1452.75M'),
    3667.25 * 1024 ** 2,
  );
  assert.equal(localSwapUsed('used = 1.5G'), 1.5 * 1024 ** 3);
  assert.equal(localSwapUsed('used = 0'), 0);
  assert.equal(localSwapUsed('unavailable'), undefined);
  assert.equal(localSwapUsed('used = 1..2M'), undefined);
});
