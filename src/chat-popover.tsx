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
  const initialFocus = useRef<'selected' | 'first' | 'last'>('selected');
  const typeahead = useRef({ text: '', at: 0 });
  const buttons = () =>
    Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  const focusOption = (button?: HTMLButtonElement) => {
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open || !ref.current || !panel.current) return;
    const boundary =
      ref.current.closest('.conversation, .drawer-body, .modal') ?? document.documentElement;
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !popup) return;
      const bounds = boundary.getBoundingClientRect();
      const left = Math.max(8, bounds.left + 8);
      const right = Math.min(window.innerWidth - 8, bounds.right - 8);
      const availableWidth = Math.max(0, right - left);
      popup.style.minWidth = `${Math.min(240, availableWidth)}px`;
      popup.style.maxWidth = `${availableWidth}px`;
      const width = popup.getBoundingClientRect().width;
      popup.style.left = `${Math.max(left - anchor.left, Math.min(0, right - anchor.left - width))}px`;
      const above = Math.max(0, anchor.top - Math.max(8, bounds.top + 8) - 8);
      const below = Math.max(
        0,
        Math.min(window.innerHeight - 8, bounds.bottom - 8) - anchor.bottom - 8,
      );
      const preferredHeight = Math.min(360, popup.scrollHeight);
      const opensBelow = above < preferredHeight && below > above;
      popup.dataset.placement = opensBelow ? 'bottom' : 'top';
      popup.style.top = opensBelow ? 'calc(100% + 8px)' : 'auto';
      popup.style.bottom = opensBelow ? 'auto' : 'calc(100% + 8px)';
      popup.style.maxHeight = `${Math.max(0, Math.min(360, opensBelow ? below : above))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(boundary);
    observer.observe(ref.current);
    window.addEventListener('resize', place);
    // A drawer can scroll without resizing; keep the menu in its visible bounds.
    boundary.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      boundary.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const options = buttons();
    const selected = options.find((button) => button.matches('.on, [aria-pressed="true"]'));
    focusOption(
      initialFocus.current === 'last'
        ? options.at(-1)
        : initialFocus.current === 'first'
          ? options[0]
          : (selected ?? options[0]),
    );
    typeahead.current = { text: '', at: 0 };
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
    <div
      className="popover-host"
      ref={ref}
      onBlur={(e) => {
        if (e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className={`chip-btn ${open || active ? 'on' : ''} ${text ? 'labeled' : ''}`}
        title={`${title ?? label} · ${label}`}
        aria-label={title ?? label}
        aria-description={label !== title ? label : undefined}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => {
          initialFocus.current = 'selected';
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          initialFocus.current = e.key === 'ArrowUp' ? 'last' : 'first';
          if (open) focusOption(e.key === 'ArrowUp' ? buttons().at(-1) : buttons()[0]);
          else setOpen(true);
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
            if (
              (e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')
            )
              return;
            if (e.altKey || e.metaKey || e.ctrlKey || e.nativeEvent.isComposing) return;
            const options = buttons();
            if (!options.length) return;
            const index = options.indexOf(document.activeElement as HTMLButtonElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              const next =
                e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? options.length - 1
                    : (index + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
              focusOption(options[next]);
            } else if (e.key.length === 1 && e.key !== ' ') {
              // Jump to a model or setting by name without another field in every menu.
              const normalize = (value: string) =>
                value
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '')
                  .toLocaleLowerCase();
              const now = Date.now();
              const text = normalize(e.key);
              const previous = now - typeahead.current.at < 700 ? typeahead.current.text : '';
              const query = previous === text ? text : previous + text;
              typeahead.current = { text: query, at: now };
              const ordered = [...options.slice(index + 1), ...options.slice(0, index + 1)];
              const match = ordered.find((button) =>
                normalize(button.textContent?.trim() ?? '').startsWith(query),
              );
              if (match) {
                e.preventDefault();
                focusOption(match);
              }
            }
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
