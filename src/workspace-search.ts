import type { Snapshot } from './shared';

export interface WorkspaceSearchResult {
  key: string;
  title: string;
  subtitle: string;
  projectId: string;
  sessionId?: string;
}

/** Bound the palette's DOM and avoid rescanning histories after the result limit. */
export function searchWorkspace(
  state: Snapshot,
  query: string,
  statusLabels: Readonly<Record<string, string>>,
  limit = 60,
): WorkspaceSearchResult[] {
  const needle = query.trim().toLowerCase();
  const results: WorkspaceSearchResult[] = [];
  if (limit <= 0) return results;
  const projects = new Map(state.projects.map((p) => [p.id, p.name]));
  const profiles = new Map((state.profiles ?? []).map((p) => [p.id, p.name]));
  const included = new Set<string>();
  const matches = (title: string, subtitle: string) =>
    `${title} ${subtitle}`.toLowerCase().includes(needle);
  for (const project of state.projects) {
    if (!matches(project.name, project.path)) continue;
    results.push({
      key: project.id,
      title: project.name,
      subtitle: project.path,
      projectId: project.id,
    });
    if (results.length >= limit) return results;
  }
  for (const session of state.sessions) {
    const subtitle = [
      projects.get(session.projectId),
      profiles.get(session.profile),
      statusLabels[session.status] ?? session.status,
    ]
      .filter(Boolean)
      .join(' · ');
    if (!matches(session.title, subtitle)) continue;
    results.push({
      key: session.id,
      title: session.title,
      subtitle,
      projectId: session.projectId,
      sessionId: session.id,
    });
    included.add(session.id);
    if (results.length >= limit) return results;
  }
  if (needle.length < 3) return results;
  for (const session of state.sessions) {
    if (included.has(session.id)) continue;
    for (const message of session.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const text = message.blocks
        ? message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join(' ')
        : message.text;
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 40);
      const end = at + needle.length + 60;
      results.push({
        key: `${session.id}:${message.id}`,
        title: session.title,
        subtitle: `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`,
        projectId: session.projectId,
        sessionId: session.id,
      });
      break;
    }
    if (results.length >= limit) break;
  }
  return results;
}
