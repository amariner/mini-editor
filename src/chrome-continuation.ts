import type { BrowserState } from './browser-protocol';
import type { ChromeConnection } from './chrome-types';
import { externalBrowserURL, isAuthenticationURL } from './browser-urls';

/** Continue in a connected profile without transferring the integrated OAuth transaction. */
export function chromeContinuation(
  source: BrowserState,
  connection: ChromeConnection,
  tabs: BrowserState[],
) {
  if (
    source.backend === 'chrome' ||
    source.projectId !== connection.projectId ||
    connection.status !== 'connected'
  )
    throw new Error('Conecta Chrome en el proyecto de esta página para continuar.');
  const url = externalBrowserURL(source.url, source.externalUrl);
  const candidates = tabs.filter(
    (tab) =>
      tab.backend === 'chrome' &&
      tab.connectionId === connection.id &&
      tab.projectId === source.projectId,
  );
  const existing =
    candidates.find((tab) => tab.url === url) ??
    (isAuthenticationURL(source.url)
      ? candidates.find((tab) => {
          try {
            return !isAuthenticationURL(tab.url) && new URL(tab.url).origin === new URL(url).origin;
          } catch {
            return false;
          }
        })
      : undefined);
  return { url, tabId: existing?.id };
}
