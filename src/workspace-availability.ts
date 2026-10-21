import type { BrowserState } from './browser-protocol';
import type { Snapshot } from './shared';

export function isLocalPage(value: string) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Only offer a browser when there is a real page or a live server in this project. */
export function workspaceAvailability(state?: Snapshot) {
  const hasAccounts = !!(state?.profiles?.length || state?.freebuffEnabled);
  const hasProjects = !!state?.projects.length;
  const projectId = state?.selectedProject;
  const sessions = new Map((state?.sessions ?? []).map((s) => [s.id, s]));
  const linked = (item: { projectId?: string; sessionId: string }) =>
    item.projectId === projectId &&
    !!projectId &&
    state?.projects.some((p) => p.id === projectId) &&
    (!item.sessionId ||
      item.sessionId === `shell:${projectId}` ||
      sessions.get(item.sessionId)?.projectId === projectId);
  const servers = (state?.devServers ?? []).filter(linked);
  const available = (tab: BrowserState) => {
    if (!linked(tab) || !tab.url) return false;
    try {
      const url = new URL(tab.url);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      if (!isLocalPage(tab.url)) return true;
      return (
        tab.hostStatus === 'online' || servers.some((s) => new URL(s.url).origin === url.origin)
      );
    } catch {
      return false;
    }
  };
  const browserTabs = (state?.browsers ?? []).filter(available);
  return {
    hasAccounts,
    hasProjects,
    hasChats: hasAccounts && hasProjects && !!state?.sessions.length,
    browserTabs,
    servers,
    canBrowse: hasAccounts && (browserTabs.length > 0 || servers.length > 0),
  };
}
