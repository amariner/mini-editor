import { RefreshCw } from 'lucide-react';
import type { Action, Session } from './shared';
export function CodexCatalogStatus({
  session,
  run,
  compact = false,
}: {
  compact?: boolean;
  session: Session;
  run: (a: Action) => Promise<any>;
}) {
  const open = ['ready', 'working', 'waiting'].includes(session.status);
  return (
    <div className="catalog-status">
      {!compact && (
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
      )}
      {(open || compact) && (
        <button
          disabled={!open || session.modelsLoading}
          aria-label="Actualizar modelos"
          title={
            session.modelsError ??
            (!open ? 'Abre el agente para consultar modelos' : 'Actualizar modelos')
          }
          onClick={() => run({ type: 'refreshCodexModels', sessionId: session.id })}
        >
          <RefreshCw size={12} />
          {!compact && (session.modelsLoading ? 'Cargando…' : 'Actualizar modelos')}
        </button>
      )}
    </div>
  );
}
