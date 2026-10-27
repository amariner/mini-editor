import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceAvailability } from '../src/workspace-availability';
import type { Snapshot } from '../src/shared';

const fixture = (changes: Partial<Snapshot> = {}) =>
  ({
    profiles: [{ id: 'claude:a', name: 'Cuenta' }],
    projects: [{ id: 'p', name: 'Proyecto', path: '/tmp/p' }],
    selectedProject: 'p',
    sessions: [{ id: 's', projectId: 'p' }],
    ...changes,
  }) as Snapshot;
const tab = (changes = {}) => ({
  id: 't',
  projectId: 'p',
  sessionId: 's',
  url: 'http://localhost:3000/',
  title: 'App',
  zoom: 1,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...changes,
});

test('el inicio ofrece solo los controles para los datos existentes', () => {
  assert.equal(workspaceAvailability().hasAccounts, false);
  assert.equal(workspaceAvailability(fixture({ profiles: [] })).hasChats, false);
  assert.equal(workspaceAvailability(fixture({ projects: [] })).hasChats, false);
  assert.equal(workspaceAvailability(fixture({ sessions: [] })).hasChats, false);
  assert.equal(workspaceAvailability(fixture()).hasChats, true);
  assert.equal(
    workspaceAvailability(fixture({ profiles: [], freebuffEnabled: true })).hasAccounts,
    true,
  );
});
test('una página local necesita un puerto confirmado, y desaparece al cerrarse', () => {
  assert.equal(workspaceAvailability(fixture({ browsers: [tab()] })).browserTabs.length, 0);
  assert.equal(
    workspaceAvailability(fixture({ browsers: [tab({ hostStatus: 'offline' })] })).browserTabs
      .length,
    0,
  );
  assert.equal(
    workspaceAvailability(fixture({ browsers: [tab({ hostStatus: 'online', suspended: true })] }))
      .canBrowse,
    true,
  );
  assert.equal(
    workspaceAvailability(
      fixture({
        devServers: [{ projectId: 'p', sessionId: 's', port: 3000, url: 'http://localhost:3000/' }],
      }),
    ).canBrowse,
    true,
  );
});
test('las páginas solicitadas desde el chat sirven, las pestañas vacías o huérfanas no', () => {
  assert.equal(
    workspaceAvailability(fixture({ browsers: [tab({ url: 'https://example.com/' })] })).canBrowse,
    true,
  );
  for (const changes of [
    { url: '' },
    { url: 'about:blank' },
    { url: 'https://example.com/', projectId: 'other' },
    { url: 'https://example.com/', sessionId: 'deleted' },
  ])
    assert.equal(
      workspaceAvailability(fixture({ browsers: [tab(changes)] })).browserTabs.length,
      0,
    );
  assert.equal(
    workspaceAvailability(
      fixture({ profiles: [], browsers: [tab({ url: 'https://example.com/' })] }),
    ).canBrowse,
    false,
  );
});

test('la consola del proyecto también puede anunciar un servidor sin crear un chat', () => {
  const state = fixture({
    sessions: [],
    browsers: [tab({ sessionId: 'shell:p', hostStatus: 'online' })],
  });
  assert.equal(workspaceAvailability(state).canBrowse, true);
  assert.equal(workspaceAvailability({ ...state, selectedProject: 'other' }).canBrowse, false);
  assert.equal(
    workspaceAvailability(
      fixture({
        sessions: [],
        devServers: [
          { projectId: 'p', sessionId: 'shell:p', port: 3000, url: 'http://localhost:3000/' },
        ],
      }),
    ).canBrowse,
    true,
  );
});

test('un proyecto puede abrir una página vacía aunque no tenga servidores', () => {
  assert.equal(workspaceAvailability(fixture()).canBrowse, true);
  assert.equal(workspaceAvailability(fixture({ selectedProject: undefined })).canBrowse, false);
});
