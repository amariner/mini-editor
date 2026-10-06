import type { Action, Snapshot } from './shared';

// Increase when the renderer needs new main-process actions or changed semantics.
export const IPC_VERSION = 11;
export const RESTART_NOTICE =
  'Hay una versión antigua de Agent Desk abierta. Cuando terminen tus agentes, actualiza la aplicación o sal con ⌘Q y vuelve a ejecutar npm run dev para activar las funciones nuevas.';

export function compatibleRuntime(state?: Snapshot) {
  return state?.runtime?.protocol === IPC_VERSION;
}

// Keep navigation and controls for existing processes available during an upgrade.
const legacyControls = new Set<Action['type']>([
  'snapshot',
  'select',
  'stop',
  'interrupt',
  'terminalWrite',
  'terminalResize',
  'terminalBuffer',
  'diff',
  'approve',
  'cancelLogin',
]);
export function assertCompatibleAction(state: Snapshot | undefined, action: Action) {
  if (
    action.type === 'restartApp' &&
    state?.runtime?.restartSupported &&
    state.runtime.updateAvailable
  )
    return;
  if (!compatibleRuntime(state) && !legacyControls.has(action.type))
    throw new Error(RESTART_NOTICE);
}

export function actionError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method 'desk:action': (Error: )?/,
    '',
  );
  if (
    message.includes('invalid_union') &&
    (message.includes('discriminator') || message.includes('discriminated'))
  )
    return RESTART_NOTICE;
  return message;
}
