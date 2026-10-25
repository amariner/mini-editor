import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

export function Popover({
  label,
  icon: Icon,
  children,
  title,
  active = false,
  text,
}: {
  active?: boolean;
  label: string;
  icon: any;
  title?: string;
  /** Visible label, only for non-default states worth noticing. */
  text?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !ref.current || !panel.current) return;
    const boundary = ref.current.closest('.conversation') ?? document.documentElement;
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !popup) return;
      const bounds = boundary.getBoundingClientRect();
      const left = Math.max(8, bounds.left + 8);
      const right = Math.min(window.innerWidth - 8, bounds.right - 8);
      popup.style.maxWidth = `${Math.max(120, right - left)}px`;
      const width = popup.getBoundingClientRect().width;
      popup.style.left = `${Math.max(left - anchor.left, Math.min(0, right - anchor.left - width))}px`;
      popup.style.maxHeight = `${Math.max(48, Math.min(360, anchor.top - Math.max(8, bounds.top) - 12))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(boundary);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k, true);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k, true);
    };
  }, [open]);
  return (
    <div className="popover-host" ref={ref}>
      <button
        ref={trigger}
        className={`chip-btn ${open || active ? 'on' : ''} ${text ? 'labeled' : ''}`}
        title={`${title ?? label} · ${label}`}
        aria-label={title ?? label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => {
            const buttons =
              panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (buttons?.length) buttons[e.key === 'ArrowUp' ? buttons.length - 1 : 0].focus();
          });
        }}
      >
        <Icon size={13} />
        {text && <span className="chip-text">{text}</span>}
      </button>
      {open && (
        <div
          className="popover"
          id={id}
          ref={panel}
          role="dialog"
          aria-label={title ?? label}
          onKeyDown={(e) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
            if ((e.target as HTMLElement).matches('input, textarea, select')) return;
            const buttons = Array.from(
              panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
            );
            if (!buttons.length) return;
            e.preventDefault();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? buttons.length - 1
                  : (index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
            buttons[next].focus();
          }}
          onBlur={(e) => {
            if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
          }}
        >
          <div className="popover-heading">
            {title ?? label}
            <span>{label !== title ? label : ''}</span>
          </div>
          {children(close)}
        </div>
      )}
    </div>
  );
}
