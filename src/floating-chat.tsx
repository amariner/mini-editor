import React, { useEffect, useRef, useState } from 'react';
import { GripHorizontal, Maximize2, Pin, PinOff, PictureInPicture2, Settings2, X } from 'lucide-react';
import type { Action, Session } from './shared';
import { MIN_FLOATING_OPACITY, type FloatingChatState } from './floating-chat-state';
import { ChatStateMark } from './chat-state-mark';
import { cardStatus } from './supervision';

export function FloatingChatHeader({
  session,
  project,
  preferences,
  run,
}: {
  session: Session;
  project: string;
  preferences?: FloatingChatState;
  run: (action: Action) => Promise<any>;
}) {
  const savedGlassStrength = preferences?.glass === false ? 0 : (preferences?.glassStrength ?? 1);
  const [glassStrength, setGlassStrength] = useState(savedGlassStrength);
  useEffect(() => setGlassStrength(savedGlassStrength), [savedGlassStrength]);
  const [options, setOptions] = useState(false);
  const [opacity, setOpacity] = useState(preferences?.opacity ?? 1);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [tone, status] = cardStatus(session);
  useEffect(() => setOpacity(preferences?.opacity ?? 1), [preferences?.opacity]);
  useEffect(() => {
    if (!options) return;
    const close = (e: Event) => {
      if (
        !popup.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOptions(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOptions(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('focusin', close);
    document.addEventListener('keydown', escape);
    popup.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('focusin', close);
      document.removeEventListener('keydown', escape);
    };
  }, [options]);
  const changeOpacity = (value: number) => {
    setOpacity(value);
    void run({
      type: 'floatingChat',
      sessionId: session.id,
      operation: 'configure',
      opacity: value,
    });
  };
  const action = (operation: 'dock' | 'close' | 'configure', update = {}) =>
    void run({ type: 'floatingChat', sessionId: session.id, operation, ...update });
  return (
    // Options are available by keyboard, a visible button, and right click.
    <header
      className="floating-chat-header"
      onContextMenu={(e) => {
        e.preventDefault();
        setOptions(true);
      }}
    >
      <span
        className="floating-chat-drag-handle"
        role="img"
        aria-label="Mover ventana"
        title="Arrastra la cabecera para mover la ventana"
      >
        <GripHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
      </span>
      <ChatStateMark tone={tone} status={status} />
      <div
        className="floating-chat-title"
        title={`${session.title} · ${project} · Arrastra para mover · Clic derecho: opciones`}
      >
        <strong>{session.title}</strong>
        <span>{project}</span>
      </div>
      <div className="floating-chat-controls">
        <button
          type="button"
          ref={trigger}
          aria-label="Opciones de ventana flotante"
          title="Apariencia de la ventana"
          aria-expanded={options}
          aria-controls={options ? 'floating-chat-options' : undefined}
          aria-haspopup="dialog"
          onClick={() => setOptions((open) => !open)}
        >
          <Settings2 size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Volver al editor"
          title="Abrir en el editor · Clic derecho en la cabecera: opciones"
          onClick={() => action('dock')}
        >
          <Maximize2 size={12} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          className="floating-chat-close"
          aria-label="Cerrar ventana flotante"
          title="Cerrar ventana flotante · conservar el chat"
          onClick={() => action('close')}
        >
          <X size={13} strokeWidth={1.5} />
        </button>
      </div>
      {options && (
        <div
          className="floating-chat-options"
          id="floating-chat-options"
          ref={popup}
          role="dialog"
          aria-label="Opciones de ventana flotante"
        >
          <strong>Apariencia de la ventana</strong>
          <button
            type="button"
            className="floating-pin"
            aria-pressed={preferences?.alwaysOnTop ?? true}
            onClick={() =>
              action('configure', { alwaysOnTop: !(preferences?.alwaysOnTop ?? true) })
            }
          >
            {(preferences?.alwaysOnTop ?? true) ? <Pin size={14} /> : <PinOff size={14} />}
            Siempre encima
            <span>{(preferences?.alwaysOnTop ?? true) ? 'Activado' : 'Desactivado'}</span>
          </button>
          <label htmlFor="floating-opacity">
            Opacidad del fondo
            <output htmlFor="floating-opacity">{Math.round(opacity * 100)}%</output>
          </label>
          <input
            id="floating-opacity"
            type="range"
            min={MIN_FLOATING_OPACITY * 100}
            max="100"
            step="1"
            value={Math.round(opacity * 100)}
            aria-valuetext={`${Math.round(opacity * 100)}%`}
            onChange={(e) => {
              changeOpacity(Number(e.target.value) / 100);
            }}
          />
          {preferences?.glassSupported && (
            <div className="floating-glass-intensity">
              <label htmlFor="floating-glass-strength">
                Intensidad del cristal
                <output htmlFor="floating-glass-strength">
                  {Math.round(glassStrength * 100)}%
                </output>
              </label>
              <input
                id="floating-glass-strength"
                type="range"
                min="0"
                max="200"
                step="10"
                value={Math.round(glassStrength * 100)}
                aria-valuetext={`${Math.round(glassStrength * 100)}%`}
                onChange={(e) => {
                  const value = Number(e.target.value) / 100;
                  setGlassStrength(value);
                  action('configure', { glass: value > 0, glassStrength: value });
                }}
              />
            </div>
          )}
          {preferences?.glassSupported && (
            <div className="floating-glass-intensity">
              <div className="floating-blur-row">
                <span>Desenfoque</span>
                <button
                  id="floating-blur"
                  type="button"
                  role="switch"
                  aria-label="Desenfoque"
                  aria-checked={preferences.blur ?? false}
                  className="floating-effect-switch"
                  onClick={() => action('configure', { blur: !(preferences.blur ?? false) })}
                >
                  <span />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

export function DetachedChat({
  session,
  run,
}: {
  session: Session;
  run: (action: Action) => Promise<any>;
}) {
  return (
    <div className="detached-chat" role="status">
      <PictureInPicture2 size={32} strokeWidth={1.3} />
      <h2>Este chat está flotando</h2>
      <p>Puedes seguir trabajando aquí mientras conversas en su ventana.</p>
      <button
        className="primary"
        onClick={() =>
          void run({ type: 'floatingChat', sessionId: session.id, operation: 'focus' })
        }
      >
        Mostrar ventana
      </button>
      <button
        className="quiet"
        onClick={() => void run({ type: 'floatingChat', sessionId: session.id, operation: 'dock' })}
      >
        Volver a poner aquí
      </button>
    </div>
  );
}
