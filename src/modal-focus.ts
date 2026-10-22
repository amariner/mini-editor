import { useLayoutEffect } from 'react';

const focusable =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])';
const visible = (element: HTMLElement) =>
  element.getClientRects().length > 0 && !element.closest('[hidden], [inert]');

/** Keep keyboard work inside the foremost modal, including nested confirmations. */
export function useModalFocus(active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const opener = document.activeElement as HTMLElement | null;
    const background = [...document.querySelectorAll<HTMLElement>('.app > aside, .app > main')];
    const wasInert = background.map((element) => element.inert);
    background.forEach((element) => (element.inert = true));
    let current: HTMLElement | undefined;
    const returnTargets = new Map<HTMLElement, HTMLElement | null>();
    const elements = (dialog: HTMLElement) =>
      [...dialog.querySelectorAll<HTMLElement>(focusable)].filter(
        (element) => element.tabIndex >= 0 && !element.matches(':disabled') && visible(element),
      );
    const sync = () => {
      const next = [
        ...document.querySelectorAll<HTMLElement>(
          '.overlay :is([role="dialog"], [role="alertdialog"])',
        ),
      ]
        .filter(visible)
        .at(-1);
      if (!next) return;
      const focused = document.activeElement as HTMLElement | null;
      const usable = (element: HTMLElement | null | undefined) =>
        !!element && element.isConnected && visible(element) && !element.matches(':disabled');
      if (next === current && focused && next.contains(focused) && usable(focused)) return;
      const previous = current;
      current = next;
      const restore = previous && !previous.isConnected ? returnTargets.get(previous) : null;
      if (usable(restore) && restore && next.contains(restore)) {
        restore.focus({ preventScroll: true });
        if (document.activeElement === restore) return;
      }
      if (previous !== next) returnTargets.set(next, focused);
      next.tabIndex = -1;
      const autofocus = next.querySelector<HTMLElement>('[data-autofocus]');
      (usable(autofocus) ? autofocus! : (elements(next)[0] ?? next)).focus({
        preventScroll: true,
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.querySelector('.app') ?? document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'open'],
    });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !current) return;
      const targets = elements(current);
      const index = targets.indexOf(document.activeElement as HTMLElement);
      if (
        !targets.length ||
        index < 0 ||
        (event.shiftKey ? index === 0 : index === targets.length - 1)
      ) {
        event.preventDefault();
        event.stopPropagation();
        (targets[event.shiftKey ? targets.length - 1 : 0] ?? current).focus();
      }
    };
    document.addEventListener('keydown', key, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', key, true);
      background.forEach((element, index) => (element.inert = wasInert[index]));
      const canRestore = (element: HTMLElement | null) =>
        !!element && element.isConnected && visible(element) && !element.matches(':disabled');
      // A resolved queue or removed account can also remove the control that opened it.
      const fallback = [
        ...document.querySelectorAll<HTMLElement>('.workspace .composer textarea:not(:disabled)'),
        ...document.querySelectorAll<HTMLElement>('.app > main > .topbar button:not(:disabled)'),
      ].find((element) => canRestore(element));
      (canRestore(opener) ? opener : fallback)?.focus({ preventScroll: true });
    };
  }, [active]);
}
