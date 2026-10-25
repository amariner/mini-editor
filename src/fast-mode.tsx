import { Popover } from './chat-popover';
import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import { providerKind, type Action, type Session } from './shared';

export function FastModeControl({
  session,
  run,
  disabled = false,
}: {
  session: Session;
  run: (action: Action) => Promise<unknown>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kind = providerKind(session.profile);
  if (kind !== 'claude' && kind !== 'codex') return null;
  const config = kind === 'claude' ? session.config : session.codexConfig;
  const enabled = !!config?.fastMode;
  const hint =
    kind === 'claude'
      ? 'Requiere Opus compatible y créditos de uso adicionales. Claude puede cambiar a Opus al activarlo.'
      : 'Solicita Fast a Codex: mayor consumo, sujeto al modelo y disponibilidad de la cuenta.';
  return (
    <Popover
      label={
        enabled ? 'Rápido solicitado' : config?.fastMode === false ? 'Estándar' : 'Por defecto'
      }
      title="Velocidad de respuesta"
      icon={Zap}
      active={enabled}
      text={enabled ? 'Rápido' : undefined}
    >
      {(close) => (
        <>
          <p className="fast-mode-hint">{hint} Se aplica a los próximos turnos.</p>
          <button
            type="button"
            aria-pressed={enabled}
            disabled={disabled || busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await run({
                  type: kind === 'claude' ? 'configure' : 'configureCodex',
                  sessionId: session.id,
                  config: { fastMode: !enabled },
                });
                close();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'No se pudo cambiar la velocidad.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {enabled ? 'Desactivar modo rápido' : 'Activar modo rápido'}
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </Popover>
  );
}
