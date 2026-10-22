import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWorkspace } from '../src/workspace-search';
import type { Snapshot } from '../src/shared';

const fixture = () =>
  ({
    projects: [{ id: 'p', name: 'Diseño', path: '/tmp/producto' }],
    profiles: [{ id: 'claude:a', name: 'Personal', kind: 'claude' }],
    sessions: [
      {
        id: 's',
        projectId: 'p',
        profile: 'claude:a',
        title: 'Revisión',
        status: 'ready',
        messages: [{ id: 'm', role: 'assistant', text: 'Hay que mejorar la navegación.' }],
      },
    ],
  }) as unknown as Snapshot;

test('el buscador normaliza espacios y busca proyectos, cuentas y estados', () => {
  const state = fixture();
  assert.equal(searchWorkspace(state, '  DISEÑO  ', { ready: 'Lista' }).length, 2);
  assert.equal(searchWorkspace(state, ' personal ', {}).at(0)?.sessionId, 's');
  assert.equal(searchWorkspace(state, ' Lista ', { ready: 'Lista' }).at(0)?.sessionId, 's');
});

test('encuentra texto del historial sin duplicar sesiones ni añadir puntos suspensivos falsos', () => {
  const state = fixture();
  assert.equal(
    searchWorkspace(state, 'navegación', {}).at(0)?.subtitle,
    'Hay que mejorar la navegación.',
  );
  state.sessions[0].messages[0].text += ' Revisión';
  assert.equal(searchWorkspace(state, 'revisión', {}).length, 1);
  assert.equal(searchWorkspace(state, 'na', {}).length, 1); // Account metadata, not history.
});

test('respeta el límite también para metadatos y no recorre historiales innecesarios', () => {
  const state = fixture();
  state.projects = Array.from({ length: 1000 }, (_, i) => ({
    id: `p${i}`,
    name: `Proyecto ${i}`,
    path: `/tmp/${i}`,
  }));
  Object.defineProperty(state.sessions[0], 'messages', {
    get: () => {
      throw new Error('No leer');
    },
  });
  assert.equal(searchWorkspace(state, '', {}).length, 60);
  assert.equal(searchWorkspace(state, 'proyecto', {}, 10).length, 10);
  assert.deepEqual(searchWorkspace(state, '', {}, 0), []);
});

test('los bloques de texto participan en búsquedas y las herramientas no', () => {
  const state = fixture();
  state.sessions[0].messages[0].blocks = [
    { type: 'text', text: 'Resultado visible' },
    { type: 'tool_use', name: 'Bash', id: 'tool', input: { command: 'contenido privado' } },
  ];
  assert.equal(searchWorkspace(state, 'resultado', {}).length, 1);
  assert.equal(searchWorkspace(state, 'privado', {}).length, 0);
});
