import type { Profile, Session } from '../src/shared';

/** Called while the account operation holds its profile lock. */
export async function stopAccountSessions(
  profile: Profile,
  confirmed: boolean,
  sessions: Session[],
  operations: ReadonlySet<string>,
  runtimes: ReadonlyMap<string, unknown>,
  stop: (id: string) => Promise<void>,
) {
  const affected = sessions.filter((s) => s.profile === profile);
  if (affected.some((s) => operations.has(s.id)))
    throw new Error(
      'Hay una operación de agente en curso. Espera a que termine y vuelve a intentarlo.',
    );
  const running = affected.filter((s) => runtimes.has(s.id));
  if (running.length && !confirmed)
    throw new Error(
      'Confirma la parada de las sesiones de este perfil antes de cambiar la cuenta.',
    );
  for (const session of running) await stop(session.id);
  if (affected.some((s) => runtimes.has(s.id)))
    throw new Error('No se ha confirmado la salida de todos los agentes de esta cuenta.');
  return affected;
}
