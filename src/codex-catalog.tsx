import { RefreshCw } from 'lucide-react';
import type { Action, Session } from './shared';
export function CodexCatalogStatus({
  session,
  run,
}: {
  session: Session;
  run: (a: Action) => Promise<any>;
}) {
  const open = ['ready', 'working', 'waiting'].includes(session.status);
  return (
    <div className="catalog-status">
      <p role="status">
        {session.modelsLoading
          ? 'Consultando modelos de Codex…'
          : (session.modelsError ??
            (!open
              ? 'Abre el agente para consultar los modelos disponibles.'
              : !session.info?.models.length
                ? 'Todavía no hay modelos disponibles.'
                : 'La selección se aplica al próximo mensaje.'))}
      </p>
      {open && (
        <button
          disabled={session.modelsLoading}
          onClick={() => run({ type: 'refreshCodexModels', sessionId: session.id })}
        >
          <RefreshCw size={12} />
          {session.modelsLoading ? 'Cargando…' : 'Actualizar modelos'}
        </button>
      )}
    </div>
  );
}
