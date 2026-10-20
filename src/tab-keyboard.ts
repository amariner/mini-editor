import type { KeyboardEvent } from 'react';

/** Native-style tab navigation, scoped to the tablist that owns the pressed key. */
export function navigateTabs(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [
    ...(event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []),
  ].filter((tab) => !tab.disabled && tab.getAttribute('aria-disabled') !== 'true');
  if (!tabs.length) return;
  event.preventDefault();
  const index = tabs.indexOf(event.currentTarget);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  tabs[next].click();
  tabs[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
