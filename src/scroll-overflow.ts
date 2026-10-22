import { useLayoutEffect, useState } from 'react';

/** Measure both the viewport and its content: adding chats can create overflow
 * without changing the height of the sidebar itself. */
export function useScrollOverflow() {
  const [viewport, viewportRef] = useState<HTMLElement | null>(null);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    if (!viewport || !content) return;
    const measure = () => setOverflow(viewport.scrollHeight > viewport.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, [viewport, content]);
  return { viewportRef, contentRef, overflow };
}
