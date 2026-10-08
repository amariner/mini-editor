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
  return (
    <div className="catalog-status">
      {(!compact || session.modelsLoading || session.modelsError) && (
        <p role="status">
          {session.modelsLoading
            ? 'Consultando modelos…'
            : (session.modelsError ??
              (!session.info?.models.length
                ? 'Todavía no hay modelos disponibles.'
                : 'La selección se aplica al próximo mensaje.'))}
        </p>
      )}
      {
        <button
          disabled={session.modelsLoading}
          aria-label="Actualizar modelos"
          title={session.modelsError ?? 'Actualizar modelos'}
          onClick={() => run({ type: 'refreshModels', sessionId: session.id })}
        >
          <RefreshCw size={12} />
          {!compact && (session.modelsLoading ? 'Cargando…' : 'Actualizar modelos')}
        </button>
      }
    </div>
  );
}
