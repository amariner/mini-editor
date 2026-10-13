import type { Message, Session } from './shared';

export function antigravityDenied(message?: Message) {
  return (
    !!message?.id.startsWith('agy-tool:') &&
    (message.tool?.status === 'declined' ||
      (message.tool?.status === 'failed' &&
        /permission check failed|user denied permission/i.test(message.tool.output ?? '')))
  );
}

export function antigravityPermissionNeeded(session?: Session) {
  if (!session?.reference?.startsWith('agy:')) return false;
  const lastUser = session.messages.map((m) => m.role).lastIndexOf('user');
  const turn = session.messages.slice(lastUser + 1);
  return !turn.some((m) => m.id.startsWith('agy-handoff:')) && turn.some(antigravityDenied);
}
