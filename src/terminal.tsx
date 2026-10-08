import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Session } from './shared';
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
const scheme = () => window.matchMedia('(prefers-color-scheme: dark)');
export function TerminalView({
  session,
  visible,
  onError,
}: {
  session: Pick<Session, 'id' | 'status'>;
  visible: boolean;
  onError: (s: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    fit = useRef<FitAddon>(null),
    terminal = useRef<Terminal>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"SF Mono", "SFMono-Regular", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 15000,
      theme: scheme().matches ? dark : light,
    });
    const media = scheme();
    const onScheme = () => {
      term.options.theme = media.matches ? dark : light;
    };
    media.addEventListener('change', onScheme);
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(host.current!);
    terminal.current = term;
    fit.current = addon;
    let disposed = false,
      ready = false,
      queue: { data: string; sequence: number }[] = [];
    const unsubscribe = window.desk.subscribe((e) => {
      if (e.type === 'terminal' && e.sessionId === session.id) {
        if (ready) term.write(e.data);
        else queue.push(e);
      }
    });
    window.desk
      .invoke({ type: 'terminalBuffer', sessionId: session.id })
      .then((buffer) => {
        if (disposed) return;
        term.write(buffer.data);
        for (const chunk of queue) if (chunk.sequence > buffer.sequence) term.write(chunk.data);
        queue = [];
        ready = true;
      })
      .catch((e) => onError(e.message));
    const input = term.onData(
      (data) =>
        void window.desk
          .invoke({ type: 'terminalWrite', sessionId: session.id, data })
          .catch((e) => onError(e.message)),
    );
    const resize = () => {
      if (host.current && host.current.clientWidth > 0 && host.current.clientHeight > 0) {
        addon.fit();
        void window.desk
          .invoke({
            type: 'terminalResize',
            sessionId: session.id,
            cols: term.cols,
            rows: term.rows,
          })
          .catch(() => {});
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    resize();
    return () => {
      disposed = true;
      media.removeEventListener('change', onScheme);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      term.dispose();
    };
  }, [session.id]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !live(session);
  }, [session.status]);
  useEffect(() => {
    if (!visible || !live(session)) return;
    const timer = setTimeout(() => {
      fit.current?.fit();
      terminal.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [visible, session.id, session.status]);
  return <div className={`terminal-wrap ${visible ? '' : 'hidden'}`} ref={host} />;
}
