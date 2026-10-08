import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Manager } from '../electron/manager';
import { Store } from '../electron/store';
import { actionSchema, profileDirectory } from '../electron/core';

async function fixture(run: (manager: Manager, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-remove-account-'));
  const manager = new Manager(root, () => {});
  try {
    await run(manager, root);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('eliminar exige confirmación y rechaza rutas y perfiles desconocidos', async () => {
  for (const input of [
    { profile: 'codex' },
    { profile: 'codex', confirmed: false },
    { profile: '../codex', confirmed: true },
  ])
    assert.equal(actionSchema.safeParse({ type: 'removeAccount', ...input }).success, false);
  await fixture(async (m) => {
    m.addAccount('codex');
    const never = async () => {
      assert.fail('No debe tocar el disco');
    };
    await assert.rejects(m.removeAccount('codex', false, never), /Confirma/);
    await assert.rejects(m.removeAccount('codex-99', true, never), /cuenta no existe/);
    assert.equal(m.state.profiles?.length, 1);
  });
});

test('elimina solo el perfil confirmado sin necesitar ejecutables; conserva copia y evita reutilizar el acceso', async () => {
  await fixture(async (m, root) => {
    const old = m.addAccount('codex', 'Antigua');
    const other = m.addAccount('claude', 'Otra');
    const project = await m.addProject(root);
    const removed = m.state.sessions[0];
    removed.messages.push({ id: 'msg', role: 'user', text: 'Mi conversación' });
    const kept = m.newSession(project.id, other.id);
    m.select(project.id, removed.id);
    m.buffers.set(removed.id, { data: 'buffer', sequence: 1 });
    m.accounts.state[old.id] = { status: 'unknown', error: 'Acceso bloqueado' };
    const archive = path.join(root, 'trash');
    await m.removeAccount(old.id, true, async (directory) => {
      assert.equal(directory, profileDirectory(root, old.id));
      assert.throws(() => m.newSession(project.id, old.id), /eliminando/);
      await assert.rejects(m.start(removed.id), /operación de esta cuenta/);
      fs.renameSync(directory, archive);
    });
    assert.equal(m.accounts.state[old.id], undefined);
    assert.equal(m.accounts.state[other.id].status, 'unknown');
    assert.deepEqual(
      m.state.sessions.map((s) => s.id),
      [kept.id],
    );
    assert.equal(m.state.selectedSession, kept.id);
    assert.deepEqual(m.state.projects, [project]);
    assert.equal(m.buffers.has(removed.id), false);
    const backup = JSON.parse(
      fs.readFileSync(path.join(archive, 'agent-desk-removed-account.json'), 'utf8'),
    );
    assert.equal(backup.sessions[0].messages[0].text, 'Mi conversación');
    assert.deepEqual(new Store(root).state.removedProfiles, [old.id]);
    // Simulate a restart; neither a removed ID nor an orphaned profile directory is reused.
    m.store.state = new Store(root).state;
    fs.mkdirSync(profileDirectory(root, 'codex-2'), { recursive: true });
    assert.equal(m.addAccount('codex').id, 'codex-3');
  });
});

test('un fallo de parada o de Papelera conserva el perfil y sus conversaciones', async () => {
  await fixture(async (m, root) => {
    const account = m.addAccount('codex');
    await m.addProject(root);
    const session = m.state.sessions[0];
    m.store.flush();
    m.runtimes.set(session.id, { buffer: '', sequence: 0 });
    const stop = m.stop;
    m.stop = async () => {
      throw new Error('Parada fallida');
    };
    await assert.rejects(
      m.removeAccount(account.id, true, async () => assert.fail()),
      /Parada fallida/,
    );
    assert.equal(m.state.sessions[0].id, session.id);
    m.stop = stop;
    m.runtimes.clear();
    await assert.rejects(
      m.removeAccount(account.id, true, async () => {
        throw new Error('Papelera no disponible');
      }),
      /Papelera no disponible/,
    );
    assert.equal(m.state.profiles?.[0].id, account.id);
    assert.equal(m.accounts.state[account.id].busy, undefined);
    assert.equal(new Store(root).state.sessions[0].id, session.id);
  });
});

test('cancela un acceso pendiente aunque falle su cancelación remota y permite eliminar la última cuenta', async () => {
  await fixture(async (m, root) => {
    const account = m.addAccount('codex');
    await m.addProject(root);
    let stopped = false;
    m.accounts.logins.set(account.id, {
      loginId: 'pending',
      rpc: {
        call: async () => {
          throw new Error('Servidor sin conexión');
        },
        stop: async () => {
          stopped = true;
        },
      } as any,
    });
    m.accounts.state[account.id] = { status: 'unknown', busy: 'signingIn', cancellable: true };
    await m.removeAccount(account.id, true, async (dir) => {
      assert.equal(stopped, true);
      fs.renameSync(dir, path.join(root, 'trash'));
    });
    assert.deepEqual(m.state.profiles, []);
    assert.equal(m.state.sessions.length, 0);
    assert.equal(m.state.selectedSession, undefined);
    assert.equal(m.accounts.active, false);
    const replacement = m.addAccount('codex');
    assert.notEqual(replacement.id, account.id);
    assert.equal(m.state.sessions[0].profile, replacement.id);
    assert.equal(m.accounts.state[replacement.id].status, 'unknown');
  });
});

for (const kind of ['claude', 'codex'] as const) {
  test(`elimina ${kind} durante una comprobación atascada y espera a su proceso`, async () => {
    await fixture(async (m, root) => {
      const binary = path.join(root, 'stuck-cli');
      fs.writeFileSync(
        binary,
        `#!${process.execPath}\nrequire('fs').writeFileSync('pid', String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`,
        { mode: 0o700 },
      );
      m.state.tools[kind] = binary;
      const account = m.addAccount(kind);
      const other = m.addAccount(kind);
      const project = await m.addProject(root);
      const session = m.state.sessions[0];
      const checking =
        kind === 'codex' ? m.accounts.readUsage(account.id) : m.accounts.refresh(account.id);
      const directory = profileDirectory(root, account.id);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(path.join(directory, 'pid'))) {
        assert.ok(Date.now() < deadline, 'El proceso de prueba debe arrancar');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const pid = Number(fs.readFileSync(path.join(directory, 'pid'), 'utf8'));
      assert.equal(m.accounts.state[account.id].busy, 'checking');
      const removal = m.removeAccount(account.id, true, async (dir) => {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        fs.renameSync(dir, path.join(root, 'trash'));
      });
      assert.throws(() => m.newSession(project.id, account.id), /eliminando/);
      await assert.rejects(m.start(session.id), /operación de esta cuenta/);
      await assert.rejects(m.accounts.refresh(account.id), /operación de cuenta/);
      await assert.rejects(
        m.removeAccount(account.id, true, async () => assert.fail()),
        /ya se está eliminando/,
      );
      await Promise.all([removal, checking]);
      assert.equal(m.accounts.state[account.id], undefined);
      assert.equal(fs.existsSync(directory), false);
      assert.ok(m.accounts.state[other.id]);
      assert.equal(m.accounts.active, false);
    });
  });
}

test('eliminar justo al empezar la consulta impide que arranque el CLI', async () => {
  await fixture(async (m, root) => {
    const account = m.addAccount('claude');
    m.state.tools.claude = '/usr/bin/false';
    const checking = m.accounts.refresh(account.id);
    await m.removeAccount(account.id, true, async (dir) =>
      fs.renameSync(dir, path.join(root, 'trash')),
    );
    await checking;
    assert.equal(m.accounts.state[account.id], undefined);
    assert.equal(fs.existsSync(profileDirectory(root, account.id)), false);
    assert.equal(m.accounts.active, false);
  });
});
