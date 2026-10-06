import React, { useCallback, useEffect, useRef, useState } from 'react';
const KEY = 'agent-desk.chat-width';
const MIN_CHAT = 220;
const MIN_TOOLS = 240;
const HANDLE = 8;
export function useWorkspaceSplit() {
  const element = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [available, setAvailable] = useState(1000);
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(KEY));
      return saved > 0 && saved < 1 ? saved : 0.5;
    } catch {
      return 0.5;
    }
  });
  const [dragging, setDragging] = useState(false);
  const max = Math.max(MIN_CHAT, available - MIN_TOOLS - HANDLE);
  const width = Math.round(Math.min(max, Math.max(MIN_CHAT, available * ratio)));
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    element.current = node;
    if (node) {
      observer.current = new ResizeObserver(([entry]) => setAvailable(entry.contentRect.width));
      observer.current.observe(node);
    }
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(ratio));
    } catch {}
  }, [ratio]);
  const setWidth = (value: number) =>
    setRatio(Math.min(max, Math.max(MIN_CHAT, value)) / available);
  const separator = (
    <div
      className="workspace-separator"
      role="separator"
      tabIndex={0}
      aria-label="Ancho del chat"
      aria-orientation="vertical"
      aria-valuemin={MIN_CHAT}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={`${width} píxeles de chat`}
      title="Arrastra para ajustar · Doble clic para centrar"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus();
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId) && element.current)
          setWidth(e.clientX - element.current.getBoundingClientRect().left);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => setRatio(0.5)}
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        setWidth(
          e.key === 'Home'
            ? MIN_CHAT
            : e.key === 'End'
              ? max
              : width + (e.key === 'ArrowLeft' ? -24 : 24),
        );
      }}
    />
  );
  return {
    ref,
    dragging,
    separator,
    style: { '--chat-width': `${width}px` } as React.CSSProperties,
  };
}
