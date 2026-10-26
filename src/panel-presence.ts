import { useEffect, useLayoutEffect, useState } from 'react';

/** Keep a closing panel mounted for its transition while its caller makes it inert. */
export function usePanelPresence(open: boolean, duration = 180) {
  const [present, setPresent] = useState(open);
  const [entered, setEntered] = useState(false);
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  useLayoutEffect(() => {
    let frame = 0;
    let nextFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      setPresent(true);
      if (reduced || duration <= 0) setEntered(true);
      else {
        // Paint the starting position before enabling the transition.
        frame = requestAnimationFrame(() => {
          nextFrame = requestAnimationFrame(() => setEntered(true));
        });
      }
    } else {
      setEntered(false);
      if (reduced || duration <= 0) setPresent(false);
      else timer = setTimeout(() => setPresent(false), duration);
    }
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
      clearTimeout(timer);
    };
  }, [open, reduced, duration]);
  return { present: open || present, visible: open && (reduced || entered) };
}
