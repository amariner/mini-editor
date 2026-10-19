import React from 'react';
import { Copy, GitBranch, Layers } from 'lucide-react';
import type { Action, Session } from './shared';
import { canIsolate, isolationLocked, liveNeighbours, wantsWorktree } from './isolation';
import { sessionIsLive } from './session-tabs';

/** Where a Claude chat works: its own worktree or the shared project folder. */
export function IsolationBar({
  session,
  sessions,
  run,
  disabled,
}: {
  session: Session;
  sessions: Session[];
  run: (action: Action) => Promise<unknown>;
  disabled: boolean;
}) {
  if (!canIsolate(session)) return null;
  const worktree = session.worktree;
  const neighbours = liveNeighbours(session, sessions).length;
  const isolated = wantsWorktree(session, sessions);
  const canChoose = !isolationLocked(session) && !sessionIsLive(session);
  const canFork =
    !!(session.forkFrom ?? (session.attempted && session.reference)) &&
    !['starting', 'working', 'waiting', 'stopping'].includes(session.status);
  return (
    <div className="isolation-bar" aria-label="Carpeta de trabajo del chat">
      {worktree ? (
        <span
          className="isolation-branch"
          title={`Worktree aislado en ${worktree.cwd}\nRama ${worktree.branch} · se fusiona en ${worktree.base}`}
        >
          <GitBranch size={12} />
          <span>{worktree.branch}</span>
          <span className="muted">← {worktree.base}</span>
        </span>
      ) : canChoose ? (
        <label
          className="isolation-toggle"
          title="Crea un git worktree y una rama propios para este chat al abrir el agente. Puedes fusionarlo o descartarlo desde la barra de Git."
        >
          <input
            type="checkbox"
            checked={isolated}
            disabled={disabled}
            onChange={(e) =>
              void run({
                type: 'setIsolation',
                sessionId: session.id,
                isolation: e.target.checked ? 'worktree' : 'shared',
              })
            }
          />
          Aislar en worktree
          {!session.isolation && neighbours > 0 && (
            <span className="muted">
              · activado: {neighbours === 1 ? 'hay otro agente' : `hay ${neighbours} agentes`} en
              este proyecto
            </span>
          )}
        </label>
      ) : (
        <span
          className="isolation-shared muted"
          title="Este chat trabaja en la carpeta del proyecto; las escrituras se coordinan con reservas."
        >
          <Layers size={12} /> Carpeta compartida
        </span>
      )}
      {canFork && (
        <button
          className="quiet isolation-fork"
          disabled={disabled}
          title="Abre una pestaña nueva con el mismo historial en otro worktree para probar otro enfoque en paralelo"
          onClick={() => void run({ type: 'forkSession', sessionId: session.id, isolate: true })}
        >
          <Copy size={12} /> Duplicar chat
        </button>
      )}
    </div>
  );
}
