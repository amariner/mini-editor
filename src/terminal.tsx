import { STYLES_EVENT } from './custom-styles';
import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ChevronsDown, ChevronsUp, MoveVertical, ScanLine, SlidersHorizontal } from 'lucide-react';
import type { Session } from './shared';
import { createTerminalStream } from './terminal-stream';
export { sessionIsLive as live } from './session-tabs';
import { sessionIsLive as live } from './session-tabs';
const light = {
  background: '#ffffff',
  foreground: '#1d1d1f',
  cursor: '#1d1d1f',
  selectionBackground: '#d7dcf7',
  black: '#1d1d1f',
  brightBlack: '#8a8a8f',
  white: '#d6d6da',
  brightWhite: '#1d1d1f',
  blue: '#2f6fed',
  brightBlue: '#2f6fed',
  cyan: '#1f8a9c',
  brightCyan: '#1f8a9c',
  green: '#1f9d55',
  brightGreen: '#1f9d55',
  magenta: '#a450c8',
  brightMagenta: '#a450c8',
  red: '#d93838',
  brightRed: '#d93838',
  yellow: '#b8860b',
  brightYellow: '#b8860b',
};
const dark = {
  background: '#1e1e1f',
  foreground: '#f3f3f1',
  cursor: '#f3f3f1',
  selectionBackground: '#39406b',
  black: '#1e1e1f',
  brightBlack: '#8f8f8c',
  white: '#c7c7c4',
  brightWhite: '#ffffff',
  blue: '#7aa2ff',
  brightBlue: '#7aa2ff',
  cyan: '#5fd3e6',
  brightCyan: '#5fd3e6',
  green: '#6ad48a',
  brightGreen: '#6ad48a',
  magenta: '#c89bff',
  brightMagenta: '#c89bff',
  red: '#ff7b7b',
  brightRed: '#ff7b7b',
  yellow: '#ffd866',
  brightYellow: '#ffd866',
};
const night = {
  background: '#191d23',
  foreground: '#d5d9df',
  cursor: '#d5d9df',
  selectionBackground: '#354453',
  black: '#191d23',
  brightBlack: '#939da9',
  white: '#b8c0ca',
  brightWhite: '#d5d9df',
  blue: '#9aafc9',
  brightBlue: '#9aafc9',
  cyan: '#93babb',
  brightCyan: '#93babb',
  green: '#9cbcaa',
  brightGreen: '#9cbcaa',
  magenta: '#b8a6c9',
  brightMagenta: '#b8a6c9',
  red: '#d59b9b',
  brightRed: '#d59b9b',
  yellow: '#ceba92',
  brightYellow: '#ceba92',
};
const terminalTheme = () => {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  if (value('--theme-terminal') === '1') {
    const palette = css.colorScheme === 'light' ? light : dark;
    return {
      ...palette,
      background: value('--code-block'),
      foreground: value('--text'),
      cursor: value('--brand'),
      selectionBackground: value('--accent-soft'),
      black: value('--code-block'),
      brightBlack: value('--muted'),
      white: value('--text-2'),
      brightWhite: value('--text'),
      blue: value('--c-blue'),
      brightBlue: value('--c-blue'),
      cyan: value('--c-cyan'),
      brightCyan: value('--c-cyan'),
      green: value('--c-green'),
      brightGreen: value('--c-green'),
      magenta: value('--c-purple'),
      brightMagenta: value('--c-purple'),
      red: value('--c-red'),
      brightRed: value('--c-red'),
      yellow: value('--warn'),
      brightYellow: value('--warn'),
    };
  }
  return value('--night-terminal') === '1' ? night : scheme().matches ? dark : light;
};
const scheme = () => window.matchMedia('(prefers-color-scheme: dark)');
export function TerminalView({
  session,
  visible,
  onError,
  scrollableScreen = false,
  placement = 'bottom',
}: {
  session: Pick<Session, 'id' | 'status'>;
  visible: boolean;
  onError: (s: string) => void;
  scrollableScreen?: boolean;
  placement?: 'bottom' | 'right';
}) {
  const [readingScreen, setReadingScreen] = useState(false);
  const [modelHelp, setModelHelp] = useState(false);
  const reading = useRef(false);
  reading.current = readingScreen;
  const reportError = useRef(onError);
  reportError.current = onError;
  const host = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    fit = useRef<FitAddon>(null),
    terminal = useRef<Terminal>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"SF Mono", "SFMono-Regular", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 15000,
      theme: terminalTheme(),
    });
    const media = scheme();
    const onScheme = () => {
      term.options.theme = terminalTheme();
    };
    media.addEventListener('change', onScheme);
    window.addEventListener(STYLES_EVENT, onScheme);
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(host.current!);
    terminal.current = term;
    fit.current = addon;
    if (scrollableScreen) {
      // A full-screen CLI can consume wheel events and has no native scrollback.
      // Read the enlarged screen first; at its edges retain the CLI's own scrolling.
      term.attachCustomWheelEventHandler((event) => {
        const view = viewport.current;
        if (!reading.current || !view || event.ctrlKey || event.metaKey || !event.deltaY)
          return true;
        const delta =
          event.deltaY *
          (event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? view.clientHeight : 1);
        const next = Math.max(
          0,
          Math.min(view.scrollHeight - view.clientHeight, view.scrollTop + delta),
        );
        if (Math.abs(next - view.scrollTop) < 1) return true;
        view.scrollTop = next;
        event.preventDefault();
        event.stopPropagation();
        return false;
      });
    }
    let disposed = false;
    const output = createTerminalStream((data) => term.write(data));
    const unsubscribe = window.desk.subscribe((e) => {
      if (e.type === 'terminal' && e.sessionId === session.id) output.push(e);
    });
    const restoreTimeout = setTimeout(() => {
      output.restore();
      reportError.current(
        'No se pudo cargar el historial de la terminal. La salida en directo sigue disponible.',
      );
    }, 10000);
    window.desk
      .invoke({ type: 'terminalBuffer', sessionId: session.id })
      .then((buffer) => {
        clearTimeout(restoreTimeout);
        if (disposed) return;
        output.restore(buffer);
      })
      .catch((e) => {
        clearTimeout(restoreTimeout);
        if (disposed) return;
        output.restore();
        reportError.current(e instanceof Error ? e.message : 'No se pudo cargar la terminal.');
      });
    const input = term.onData(
      (data) =>
        void window.desk
          .invoke({ type: 'terminalWrite', sessionId: session.id, data })
          .catch((e) => {
            if (!disposed) reportError.current(e.message);
          }),
    );
    let lastSize = '';
    const sendSize = () => {
      const size = `${term.cols}:${term.rows}`;
      if (disposed || size === lastSize) return;
      lastSize = size;
      void window.desk
        .invoke({
          type: 'terminalResize',
          sessionId: session.id,
          cols: term.cols,
          rows: term.rows,
        })
        .catch(() => {});
    };
    // Both the observer and explicit fit on reveal go through the same deduplicated resize.
    const resized = term.onResize(sendSize);
    let resizeFrame = 0;
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (
          !disposed &&
          host.current &&
          host.current.clientWidth > 0 &&
          host.current.clientHeight > 0
        ) {
          addon.fit();
          sendSize();
        }
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    resize();
    return () => {
      disposed = true;
      clearTimeout(restoreTimeout);
      cancelAnimationFrame(resizeFrame);
      output.dispose();
      media.removeEventListener('change', onScheme);
      window.removeEventListener(STYLES_EVENT, onScheme);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      resized.dispose();
      term.dispose();
      terminal.current = null;
      fit.current = null;
    };
  }, [session.id, scrollableScreen]);
  useEffect(() => {
    setReadingScreen(false);
    setModelHelp(false);
  }, [session.id]);
  useEffect(() => {
    if (!readingScreen) viewport.current?.scrollTo({ top: 0 });
  }, [readingScreen]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !live(session);
  }, [session.id, session.status, scrollableScreen]);
  useEffect(() => {
    if (!visible || !live(session)) return;
    const timer = setTimeout(() => {
      fit.current?.fit();
      // Status changes must not pull the caret away from a field the user is typing in.
      const a = document.activeElement;
      if (
        !a ||
        a === document.body ||
        a.closest('.terminal-wrap, .terminal-toggle[aria-pressed="true"]')
      )
        terminal.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [visible, session.id, session.status, placement]);
  if (scrollableScreen)
    return (
      <div
        className={`terminal-wrap interactive-terminal ${readingScreen ? 'reading-screen' : ''} ${visible ? '' : 'hidden'}`}
      >
        <div
          className="terminal-reading-controls"
          role="toolbar"
          aria-label="Desplazamiento de la terminal"
        >
          <button
            aria-label="Cambiar modelo"
            title="Cambiar modelo"
            aria-expanded={modelHelp}
            onClick={() => {
              setModelHelp((v) => !v);
              setReadingScreen(false);
              terminal.current?.focus();
            }}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
          </button>
          <button
            aria-label={readingScreen ? 'Ajustar al panel' : 'Leer pantalla larga'}
            aria-pressed={readingScreen}
            onClick={() => setReadingScreen((v) => !v)}
            title={readingScreen ? 'Ajustar al panel' : 'Leer pantalla larga'}
          >
            {readingScreen ? (
              <ScanLine size={15} aria-hidden="true" />
            ) : (
              <MoveVertical size={15} aria-hidden="true" />
            )}
          </button>
          {readingScreen && (
            <>
              <button
                aria-label="Inicio"
                title="Inicio"
                onClick={() => {
                  terminal.current?.scrollToTop();
                  viewport.current?.scrollTo({ top: 0 });
                }}
              >
                <ChevronsUp size={15} aria-hidden="true" />
              </button>
              <button
                aria-label="Final"
                title="Final"
                onClick={() => {
                  terminal.current?.scrollToBottom();
                  const view = viewport.current;
                  if (view) view.scrollTo({ top: view.scrollHeight });
                }}
              >
                <ChevronsDown size={15} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        {modelHelp && (
          <div className="terminal-model-help" role="note">
            En la terminal, escribe <code>/model</code> y pulsa Intro. Selecciona el modelo con ↑ ↓
            y confirma con Intro; Esc cierra el selector. Si tienes un mensaje escrito, guárdalo
            antes de introducir el comando.
          </div>
        )}
        <div
          className="terminal-screen-viewport"
          ref={viewport}
          tabIndex={0}
          aria-label="Pantalla desplazable de Antigravity"
        >
          <div className="terminal-screen">
            <div className="terminal-host" ref={host} />
          </div>
        </div>
      </div>
    );
  return (
    <div className={`terminal-wrap ${visible ? '' : 'hidden'}`}>
      <div className="terminal-host" ref={host} />
    </div>
  );
}
