import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, PictureInPicture2 } from 'lucide-react';
import type { Action, Session } from './shared';
import './chat-detach-drag.css';

type Point = { x: number; y: number; outside: boolean };
type Options = {
  session: Session;
  run: (action: Action) => Promise<unknown>;
  floating?: boolean;
  disabled?: boolean;
  sourceZone?: string;
  onDropInside?: (x: number, y: number) => void;
  onDragMove?: (x: number, y: number, outside: boolean) => void;
  onDragEnd?: () => void;
};

export const chatDetachHint = 'Arrastra fuera para abrir en una ventana flotante · Alt+Mayús+F';

/** A real pointer release commits the gesture; cancellation never opens a window. */
export function useChatDetachDrag(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [point, setPoint] = useState<Point>();
  const cancel = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      cancel.current?.();
      clearTimeout(clickTimer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (options.disabled) cancel.current?.();
    // A remote selection can replace a handle's chat while the pointer is held.
    return () => cancel.current?.();
  }, [options.disabled, options.session.id]);
  const detach = () => {
    const value = latest.current;
    if (!value.disabled)
      void value.run({
        type: 'floatingChat',
        sessionId: value.session.id,
        operation: value.floating ? 'focus' : 'open',
      });
  };
  const handleProps: React.HTMLAttributes<HTMLElement> = {
    'aria-keyshortcuts': 'Alt+Shift+F',
    onDragStart: (event) => event.preventDefault(),
    onClickCapture: (event) => {
      if (!suppressClick.current) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick.current = false;
    },
    onKeyDown: (event) => {
      if (event.altKey && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        detach();
      }
    },
    onPointerDown: (event) => {
      if (options.disabled || event.button !== 0 || !event.isPrimary) return;
      cancel.current?.();
      clearTimeout(clickTimer.current);
      suppressClick.current = false;
      const handle = event.currentTarget;
      const zone =
        handle.closest(options.sourceZone ?? '.sidebar, .multichat-scroll, .chat-switcher') ??
        handle;
      const start = { x: event.clientX, y: event.clientY };
      const pointerId = event.pointerId;
      let active = false;
      let frame = 0;
      let pending: Point | undefined;
      const location = (x: number, y: number): Point => {
        const bounds = zone.getBoundingClientRect();
        return {
          x,
          y,
          outside: x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom,
        };
      };
      const cleanup = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', abort, true);
        window.removeEventListener('keydown', key, true);
        window.removeEventListener('blur', abort);
        handle.removeEventListener('lostpointercapture', abort);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        document.body.classList.remove('chat-detach-active');
        cancel.current = undefined;
        setPoint(undefined);
        if (active) {
          suppressClick.current = true;
          clickTimer.current = setTimeout(() => {
            suppressClick.current = false;
          }, 250);
          latest.current.onDragEnd?.();
        }
      };
      const abort = () => cleanup();
      const key = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        handle.focus({ preventScroll: true });
      };
      const move = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        if (!active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 7) return;
        active = true;
        e.preventDefault();
        document.body.classList.add('chat-detach-active');
        pending = location(e.clientX, e.clientY);
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (!pending) return;
            setPoint(pending);
            latest.current.onDragMove?.(pending.x, pending.y, pending.outside);
          });
      };
      const up = (e: PointerEvent) => {
        if (e.pointerId !== pointerId) return;
        const destination = location(e.clientX, e.clientY);
        const committed = active;
        cleanup();
        if (!committed || latest.current.disabled) return;
        e.preventDefault();
        if (destination.outside) detach();
        else latest.current.onDropInside?.(destination.x, destination.y);
      };
      cancel.current = abort;
      handle.setPointerCapture(pointerId);
      handle.addEventListener('lostpointercapture', abort);
      window.addEventListener('pointermove', move, { capture: true, passive: false });
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', abort, true);
      window.addEventListener('keydown', key, true);
      window.addEventListener('blur', abort);
    },
  };
  const preview =
    point &&
    createPortal(
      <div
        className={`chat-detach-preview ${point.outside ? 'outside' : ''}`}
        style={{
          left: Math.max(8, Math.min(point.x + 18, window.innerWidth - 256)),
          top: Math.max(8, Math.min(point.y + 14, window.innerHeight - 76)),
        }}
        data-detach-ready={point.outside}
        role="status"
        aria-live="polite"
      >
        <span className="chat-detach-preview-icon" aria-hidden="true">
          {point.outside ? <PictureInPicture2 size={19} /> : <GripVertical size={17} />}
        </span>
        <span className="chat-detach-preview-copy">
          <strong>{options.session.title}</strong>
          <small>
            {point.outside
              ? 'Soltar para abrir ventana flotante'
              : options.onDropInside
                ? 'Arrastra para ordenar o separar'
                : 'Arrastra fuera para separar'}
          </small>
        </span>
      </div>,
      document.body,
    );
  return { handleProps, preview, dragging: !!point };
}
