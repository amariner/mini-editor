import React, { useEffect, useId, useSyncExternalStore } from 'react';
import { Square, Volume2 } from 'lucide-react';
import { responseReader } from './read-aloud';

export function ReadAloudButton({ text }: { text: string }) {
  const id = useId();
  const state = useSyncExternalStore(
    responseReader.subscribe,
    responseReader.getSnapshot,
    responseReader.getSnapshot,
  );
  const reading = state.id === id && state.status === 'reading';
  const error = state.id === id && state.status === 'error' ? state.error : undefined;
  useEffect(() => () => responseReader.stop(id), [id]);
  const label = reading ? 'Detener lectura' : 'Leer respuesta en voz alta';
  return (
    <>
      <button
        className={`msg-action read-aloud ${reading ? 'reading' : ''}`}
        aria-label={label}
        title={label}
        aria-pressed={reading}
        onClick={() => (reading ? responseReader.stop(id) : responseReader.start(id, text))}
      >
        {reading ? <Square size={13} /> : <Volume2 size={13} />}
      </button>
      {error && (
        <span className="reader-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
