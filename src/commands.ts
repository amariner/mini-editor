import type { Snapshot } from './shared';
import type { WorkspaceSearchResult } from './workspace-search';
import { searchWorkspace } from './workspace-search';

/** One catalog for discovery, keyboard dispatch and menus. Actions remain in the app's handlers. */
export const deskCommands = [
  {
    id: 'attention',
    title: 'Centro de atención',
    subtitle: 'Supervisar agentes y revisar entregas',
    shortcut: '⌘⇧A',
    key: 'a',
    shift: true,
  },
  {
    id: 'newChat',
    title: 'Nuevo chat',
    subtitle: 'Crear una conversación en este proyecto',
    shortcut: '⌘N',
    key: 'n',
    project: true,
  },
  {
    id: 'settings',
    title: 'Abrir ajustes',
    subtitle: 'Cuentas, interfaz y herramientas',
    shortcut: '⌘,',
    key: ',',
  },
  {
    id: 'sidebar',
    title: 'Plegar o desplegar proyectos',
    subtitle: 'Mostrar u ocultar la navegación',
    shortcut: '⌘B',
    key: 'b',
  },
  {
    id: 'changes',
    title: 'Ver cambios',
    subtitle: 'Revisar los archivos del proyecto',
    project: true,
  },
  {
    id: 'files',
    title: 'Abrir archivos',
    subtitle: 'Explorar los archivos del proyecto',
    project: true,
  },
  {
    id: 'terminal',
    title: 'Abrir terminal',
    subtitle: 'Mostrar el terminal del proyecto',
    project: true,
  },
  {
    id: 'details',
    title: 'Información del chat',
    subtitle: 'Estado, motor y contexto',
    chat: true,
  },
  {
    id: 'floating',
    title: 'Sacar chat a una ventana',
    subtitle: 'Mantener la conversación a mano',
    chat: true,
  },
  {
    id: 'interrupt',
    title: 'Interrumpir el turno',
    subtitle: 'Pausar también los envíos pendientes',
    working: true,
  },
] as const;
export type DeskCommandId = (typeof deskCommands)[number]['id'];
export function commandFromKey(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): DeskCommandId | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  return deskCommands.find(
    (c) =>
      'key' in c &&
      c.key === event.key.toLowerCase() &&
      ('shift' in c ? c.shift : false) === event.shiftKey,
  )?.id;
}
export interface DeskSearchResult extends WorkspaceSearchResult {
  command?: DeskCommandId;
  shortcut?: string;
}
export function searchDesk(
  state: Snapshot,
  query: string,
  labels: Readonly<Record<string, string>>,
): DeskSearchResult[] {
  if (!query.trimStart().startsWith('>')) return searchWorkspace(state, query, labels);
  const needle = query.trimStart().slice(1).trim().toLocaleLowerCase();
  const session = state.sessions.find((s) => s.id === state.selectedSession);
  return deskCommands
    .filter((command) => {
      if ('project' in command && !state.selectedProject) return false;
      if ('chat' in command && (!session || session.mode === 'terminal')) return false;
      if (
        'working' in command &&
        (!session ||
          session.mode === 'terminal' ||
          !['working', 'waiting'].includes(session.status))
      )
        return false;
      return `${command.title} ${command.subtitle}`.toLocaleLowerCase().includes(needle);
    })
    .map((c) => ({
      key: `command:${c.id}`,
      command: c.id,
      title: c.title,
      subtitle: c.subtitle,
      projectId: state.selectedProject ?? '',
      shortcut: 'shortcut' in c ? c.shortcut : undefined,
    }));
}
