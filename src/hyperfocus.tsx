import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Minimize2 } from 'lucide-react';
import { AttachmentPreview, Composer } from './chat';
import { Markdown } from './markdown';
import { hyperfocusTurn } from './hyperfocus-state';
import './hyperfocus.css';

type Props = Omit<
  React.ComponentProps<typeof Composer>,
  'minimal' | 'accountControl' | 'footerControl' | 'usageDetail'
> & {
  onExit: () => void;
  error?: string;
  needsAttention?: boolean;
};

/** Fade one exchange out before revealing the next; rapid updates keep only the latest target. */
function useSoftTurn(turn: ReturnType<typeof hyperfocusTurn>) {
  const [shown, setShown] = useState(turn);
  const current = useRef(turn);
  const content = useRef<HTMLDivElement>(null);
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  useEffect(() => {
    const node = content.current;
    if (!node) return;
    if (reduced) {
      current.current = turn;
      setShown(turn);
      node.style.opacity = '';
      return;
    }
    if (current.current.user === turn.user && current.current.answer === turn.answer) {
      node.style.opacity = '';
      return;
    }
    let cancelled = false;
    let animation: Animation | undefined;
    const swap = async () => {
      if (current.current.user || current.current.answer) {
        animation = node.animate([{ opacity: getComputedStyle(node).opacity }, { opacity: 0 }], {
          duration: 280,
          easing: 'ease-in-out',
          fill: 'forwards',
        });
        await animation.finished.catch(() => {});
      } else await Promise.resolve();
      if (cancelled) return;
      node.style.opacity = '0';
      animation?.cancel();
      // Commit the new content at zero opacity, before starting its entrance.
      flushSync(() => {
        current.current = turn;
        setShown(turn);
      });
      animation = node.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 620,
        easing: 'cubic-bezier(.2, 0, .2, 1)',
        fill: 'forwards',
      });
      await animation.finished.catch(() => {});
      if (!cancelled) {
        node.style.opacity = '';
        animation.cancel();
      }
    };
    void swap();
    return () => {
      cancelled = true;
      // Preserve the current opacity when an incoming update interrupts a fade.
      node.style.opacity = getComputedStyle(node).opacity;
      animation?.cancel();
    };
  }, [turn.user, turn.answer, reduced]);
  return { shown, content };
}

/** Keep a small reading window; only soften edges that actually hide more text. */
function ReadingAnswer({ text }: { text: string }) {
  const reader = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  useLayoutEffect(() => {
    const node = reader.current;
    if (!node) return;
    node.scrollTop = 0;
    const sync = () => {
      const above = node.scrollTop > 1;
      const below = node.scrollHeight - node.clientHeight - node.scrollTop > 1;
      setEdges((previous) =>
        previous.above === above && previous.below === below ? previous : { above, below },
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', sync, { passive: true });
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', sync);
    };
  }, [text]);
  return (
    <div
      className="hyperfocus-answer"
      ref={reader}
      role="region"
      aria-label="Última respuesta"
      tabIndex={0}
      data-above={edges.above}
      data-below={edges.below}
    >
      <Markdown text={text} />
    </div>
  );
}

export function Hyperfocus({ onExit, error, needsAttention, ...composer }: Props) {
  const { session } = composer;
  const root = useRef<HTMLDivElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const turn = useMemo(
    () => hyperfocusTurn(session),
    [session.messages, session.status, session.approvals.length],
  );
  const { shown, content } = useSoftTurn(turn);
  useEffect(() => {
    root.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
  }, [session.id]);
  useEffect(() => {
    // A new pair starts at its beginning. Long answers scroll independently of the input.
    if (messages.current) messages.current.scrollTop = 0;
  }, [shown.user?.id, shown.answer]);
  const attention =
    needsAttention ||
    session.approvals.length > 0 ||
    session.status === 'waiting' ||
    session.pendingInputs?.some((input) => input.status === 'failed');
  const preparing = !attention && ['starting', 'working'].includes(session.status);
  return (
    <div className="app hyperfocus" ref={root}>
      <div className="hyperfocus-window-drag" aria-hidden="true" />
      <button
        className={`hyperfocus-exit ${attention ? 'needs-attention' : ''}`}
        aria-label="Volver al modo normal"
        title={
          attention
            ? 'El chat necesita tu atención · Volver al modo normal'
            : 'Volver al modo normal · Esc'
        }
        onClick={onExit}
      >
        <Minimize2 size={15} aria-hidden="true" />
        {attention && <span role="status">Revisar solicitud</span>}
      </button>
      <main className="conversation hyperfocus-conversation" aria-label="Hiperfocus">
        <div className="hyperfocus-stage">
          <div className="hyperfocus-reading-slot">
            <div
              className="hyperfocus-messages"
              ref={messages}
              role="region"
              aria-label="Último intercambio"
              tabIndex={0}
              hidden={!shown.user && !shown.answer}
            >
              <div className="hyperfocus-turn" ref={content}>
                {shown.user && (
                  <div className="hyperfocus-user" aria-label="Tu último mensaje">
                    {shown.user.text && <p>{shown.user.text}</p>}
                    {!!shown.user.attachments?.length && (
                      <div className="hyperfocus-attachments">
                        {shown.user.attachments.map((file) => (
                          <AttachmentPreview key={file.id} attachment={file} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {shown.answer && <ReadingAnswer text={shown.answer} />}
              </div>
            </div>
          </div>
          {preparing && (
            <div className="hyperfocus-loading" role="status" aria-label="Preparando respuesta">
              <i aria-hidden="true" />
              <span className="sr-only">Preparando respuesta</span>
            </div>
          )}
          <div className="hyperfocus-writing">
            <div className="desk-input" aria-busy={turn.pending}>
              <Composer {...composer} minimal />
            </div>
            {(error || session.error) && (
              <p className="hyperfocus-error" role="alert">
                {error || session.error}
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
