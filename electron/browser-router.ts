import { browserInput, type BrowserState } from '../src/browser-protocol';
import type { BrowserDownload } from '../src/browser-downloads';
import type { ChromeConnection } from '../src/chrome-types';

interface Backend {
  snapshot(): BrowserState[];
  downloadSnapshot(): BrowserDownload[];
  forSession(
    sessionId: string,
    projectId: string,
    input: unknown,
    activate?: boolean,
  ): Promise<unknown>;
}

/** Keep the existing default; an explicit Chrome tab selects its connection. */
export async function routeBrowserForSession(
  integrated: Backend,
  chrome: Backend & { connections(): ChromeConnection[] },
  sessionId: string,
  projectId: string,
  input: unknown,
  activate = false,
) {
  const args = browserInput.parse(input);
  if (args.action === 'list')
    return {
      tabs: [...integrated.snapshot(), ...chrome.snapshot()].filter(
        (tab) => tab.projectId === projectId,
      ),
      connections: chrome.connections().filter((connection) => connection.projectId === projectId),
    };
  if (args.action === 'downloads' && !args.tabId)
    return {
      downloads: [...integrated.downloadSnapshot(), ...chrome.downloadSnapshot()]
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.startedAt - a.startedAt),
    };
  if (args.tabId) {
    const target = chrome.snapshot().find((tab) => tab.id === args.tabId);
    if (target) {
      if (target.projectId !== projectId)
        throw new Error('La pestaña no pertenece a este proyecto.');
      return chrome.forSession(sessionId, projectId, args);
    }
    // A disconnected or deleted Chrome tab must never silently create a different page.
    if (!integrated.snapshot().some((tab) => tab.id === args.tabId && tab.projectId === projectId))
      throw new Error(
        'La pestaña ya no está conectada a este proyecto. Consulta list y vuelve a conectar Chrome si hace falta.',
      );
  }
  return integrated.forSession(sessionId, projectId, args, activate);
}
