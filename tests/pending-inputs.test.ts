import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingInputs } from '../electron/pending-inputs';
import { Manager } from '../electron/manager';
import type { Session } from '../src/shared';
import type { PreparedAttachment } from '../electron/attachments';
const chat = (): Session => ({
  id: 's',
  projectId: 'p',
  profile: 'codex',
  title: 'Chat',
  status: 'working',
  messages: [],
  approvals: [],
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('la cola conserva orden y adjuntos, espera disponibilidad y permite cancelar', async () => {
  const s = chat(),
    sent: string[] = [];
  const file = {
    attachment: { id: 'f', name: 'datos.csv' },
    path: '/tmp/datos.csv',
    mediaType: 'text/csv',
    data: '',
  } satisfies PreparedAttachment;
  const q = new PendingInputs({
    sessions: () => [s],
    ready: (s) => s.status === 'ready',
    changed: () => {},
    send: async (_id, text, files) => {
      sent.push(text);
      if (text === 'primero') assert.deepEqual(files, [file]);
      s.status = 'working';
    },
  });
  q.enqueue(s, 'primero', [file]);
  q.enqueue(s, 'cancelar', []);
  q.enqueue(s, 'tercero', []);
  q.cancel(s, s.pendingInputs![1].id);
  q.pump();
  assert.deepEqual(sent, []);
  s.status = 'ready';
  q.pump();
  q.pump();
  await tick();
  assert.deepEqual(sent, ['primero']);
  s.status = 'ready';
  q.pump();
  await tick();
  assert.deepEqual(sent, ['primero', 'tercero']);
  assert.equal(s.pendingInputs!.length, 0);
});
test('un error conserva el texto y no provoca reenvíos automáticos', async () => {
  const s = chat();
  let calls = 0;
  const q = new PendingInputs({
    sessions: () => [s],
    ready: () => true,
    changed: () => {},
    send: async () => {
      calls++;
      throw new Error('Sin conexión');
    },
  });
  q.enqueue(s, 'Corrección importante', []);
  q.pump();
  await tick();
  q.pump();
  assert.equal(calls, 1);
  assert.equal(s.pendingInputs![0].status, 'failed');
  assert.equal(s.pendingInputs![0].text, 'Corrección importante');
});
test('detener el chat conserva pendientes recuperables sin ejecutarlos al reabrir', () => {
  const s = chat();
  let sent = false;
  const q = new PendingInputs({
    sessions: () => [s],
    ready: () => true,
    changed: () => {},
    send: async () => {
      sent = true;
    },
  });
  q.enqueue(s, 'Cuando termines sube a GitHub', []);
  q.pause(s);
  q.pump();
  assert.equal(sent, false);
  assert.equal(s.pendingInputs![0].status, 'failed');
});
function harness() {
  const s = chat();
  s.turnId = 'turn-active';
  s.reference = 'thread';
  const calls: any[] = [];
  const manager: Manager = Object.assign(Object.create(Manager.prototype), {
    store: { state: { sessions: [s], projects: [{ id: 'p', path: '/tmp' }] } },
    operations: new Set(),
    operationWork: new Map(),
    removingProjects: new Map(),
    accounts: { removing: () => false },
    changed: () => {},
    runtimes: new Map([
      [
        's',
        {
          rpc: {
            call: async (method: string, params: any) => {
              calls.push({ method, params });
              return { turnId: 'turn-active' };
            },
          },
        },
      ],
    ]),
  });
  return { s, calls, manager };
}
test('Codex recibe correcciones en el turno activo sin interrumpir ni iniciar otro turno', async () => {
  const { s, calls, manager } = harness();
  assert.equal(await manager.send(s.id, 'Los valores correctos son 10 y 20'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'turn/steer');
  assert.equal(calls[0].params.expectedTurnId, 'turn-active');
  assert.equal(calls[0].params.threadId, 'thread');
  assert.match(JSON.stringify(calls[0].params.input), /10 y 20/);
  assert.equal(s.status, 'working');
});
test('el cambio de turno rechazado por Codex no duplica la instrucción', async () => {
  const { s, calls, manager } = harness();
  manager.runtimes.get(s.id)!.rpc!.call = async (method: string) => {
    calls.push(method);
    throw new Error('Turn mismatch');
  };
  await assert.rejects(manager.send(s.id, 'Corrige esto'), /Turn mismatch/);
  assert.deepEqual(calls, ['turn/steer']);
  assert.equal(s.messages.length, 0);
});

test('Codex conserva adjuntos al recibir el evento antes de confirmar la corrección', async () => {
  const { s, manager } = harness();
  const file = {
    attachment: { id: 'f', name: 'datos.csv', mediaType: 'text/csv' },
    path: '/tmp/datos.csv',
    mediaType: 'text/csv',
    data: '',
  };
  manager.runtimes.get(s.id)!.rpc!.call = async (_method: string, params: any) => {
    const event = {
      threadId: s.reference,
      item: {
        id: 'server-message',
        clientId: params.clientUserMessageId,
        type: 'userMessage',
        content: params.input,
      },
    };
    manager.notification(s, { method: 'item/started', params: event });
    manager.notification(s, { method: 'item/completed', params: event });
    return { turnId: s.turnId };
  };
  await manager.send(s.id, 'Usa estos valores', [file]);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, 'Usa estos valores');
  assert.deepEqual(s.messages[0].attachments, [file.attachment]);
});

test('una indicación durante el arranque nunca adelanta al primer mensaje', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-input-order-'));
  const manager = new Manager(root, () => {});
  try {
    manager.state.profiles = [{ id: 'claude-1', kind: 'claude', name: 'Claude' }];
    manager.state.projects = [{ id: 'p', name: 'P', path: root }];
    const s = manager.newSession('p', 'claude-1', 'chat');
    const sent: string[] = [];
    let release!: () => void;
    manager.start = async (id: string) =>
      manager.exclusive(id, async () => {
        s.status = 'starting';
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        manager.runtimes.set(id, {
          buffer: '',
          sequence: 0,
          claude: {
            send: (text: string) => {
              sent.push(text);
              s.status = 'working';
            },
          } as any,
        });
        s.status = 'ready';
        manager.changed();
      });
    const first = manager.send(s.id, 'Primera tarea');
    await tick();
    await manager.send(s.id, 'Corrección posterior');
    release();
    await first;
    await tick();
    await tick();
    assert.deepEqual(sent, ['Primera tarea', 'Corrección posterior']);
    assert.equal(s.pendingInputs?.length, 0);
  } finally {
    manager.runtimes.clear();
    await manager.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('study style survives the queue without changing visible text', async () => {
  const s = chat();
  const sent: unknown[][] = [];
  const q = new PendingInputs({
    sessions: () => [s],
    ready: () => true,
    changed: () => {},
    send: async (...args) => {
      sent.push(args);
    },
  });
  q.enqueue(s, 'Fotosíntesis', [], 'study');
  assert.equal(s.pendingInputs![0].text, 'Fotosíntesis');
  q.pump();
  await tick();
  assert.deepEqual(sent, [['s', 'Fotosíntesis', [], 'study']]);
});

test('Codex study prompt stays out of visible text on repeated server events', async () => {
  const { s, manager } = harness();
  manager.runtimes.get(s.id)!.rpc!.call = async (_method: string, params: any) => {
    assert.match(JSON.stringify(params.input), /response_style/);
    const event = {
      threadId: s.reference,
      item: {
        id: 'study-message',
        clientId: params.clientUserMessageId,
        type: 'userMessage',
        content: params.input,
      },
    };
    manager.notification(s, { method: 'item/started', params: event });
    manager.notification(s, { method: 'item/completed', params: event });
    return { turnId: s.turnId };
  };
  await manager.send(s.id, 'Fotosíntesis', [], 'study');
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].text, 'Fotosíntesis');
});

test('Codex initial study echo without attachments preserves the original phrase', () => {
  const { s, manager } = harness();
  const rt = manager.runtimes.get(s.id)!;
  rt.pendingUserText = 'Mi pregunta';
  rt.pendingImages = [];
  const params = {
    threadId: s.reference,
    item: {
      id: 'initial-study',
      type: 'userMessage',
      content: [
        { type: 'text', text: 'Mi pregunta\n<response_style>Formato de estudio</response_style>' },
      ],
    },
  };
  manager.notification(s, { method: 'item/started', params });
  manager.notification(s, { method: 'item/completed', params });
  assert.equal(s.messages[0].text, 'Mi pregunta');
  assert.equal(rt.pendingUserText, undefined);
});
