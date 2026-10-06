import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, Globe, X, ArrowUpRight } from 'lucide-react';
import type { BrowserInput, BrowserState } from './browser-protocol';
export function BrowserPanel({
  sessionId,
  state,
  blocked,
  close,
  onError,
}: {
  sessionId: string;
  state?: BrowserState;
  blocked: boolean;
  close: () => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(state?.url ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setAddress(state?.url ?? ''), [state?.url, sessionId]);
  useEffect(() => {
    let frame = 0;
    let last = '';
    let disposed = false;
    const sync = () => {
      if (disposed) return;
      const rect = host.current?.getBoundingClientRect();
      if (rect) {
        const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const visible = !blocked && !!state?.url;
        const value = JSON.stringify({ bounds, visible });
        if (value !== last) {
          last = value;
          void window.desk
            .invoke({ type: 'browserPresent', sessionId, bounds, visible })
            .catch((e) => onError(e.message));
        }
      }
      frame = requestAnimationFrame(sync);
    };
    sync();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      void window.desk
        .invoke({
          type: 'browserPresent',
          sessionId,
          visible: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        })
        .catch(() => {});
    };
  }, [sessionId, blocked, !!state?.url]);
  const act = async (input: BrowserInput) => {
    setBusy(true);
    try {
      await window.desk.invoke({ type: 'browser', sessionId, input });
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tool-pane browser-pane">
      <form
        className="browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (address.trim()) void act({ action: 'navigate', url: address });
        }}
      >
        <button
          type="button"
          title="Atrás"
          aria-label="Atrás"
          disabled={!state?.canGoBack || busy}
          onClick={() => void act({ action: 'back' })}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          title="Adelante"
          aria-label="Adelante"
          disabled={!state?.canGoForward || busy}
          onClick={() => void act({ action: 'forward' })}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          title="Recargar página"
          aria-label="Recargar página"
          disabled={!state?.url || busy}
          onClick={() => void act({ action: 'reload' })}
        >
          <RefreshCw size={14} className={state?.loading ? 'spinning' : ''} />
        </button>
        <input
          aria-label="Dirección web"
          placeholder="localhost:3000 o una URL"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
        />
        <button
          title="Ir a la dirección"
          aria-label="Ir a la dirección"
          disabled={!address.trim() || busy}
        >
          <ArrowUpRight size={14} />
        </button>
        <button
          type="button"
          aria-label="Cerrar navegador"
          title="Cerrar navegador"
          onClick={() => {
            void act({ action: 'close' });
            close();
          }}
        >
          <X size={16} />
        </button>
      </form>
      {state?.error && <p className="browser-error">{state.error}</p>}
      <div ref={host} className="browser-viewport">
        {!state?.url && (
          <div className="browser-empty">
            <Globe size={28} />
          </div>
        )}
      </div>
    </section>
  );
}
