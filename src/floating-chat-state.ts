// Shared renderer values stay independent of the main process's IPC validators.
export const MIN_FLOATING_OPACITY = 0;

export interface FloatingChatState {
  sessionId: string;
  opacity: number;
  alwaysOnTop: boolean;
  glass?: boolean;
  blur?: boolean;
  glassStrength?: number;
  glassSupported?: boolean;
}

export const floatingChatHash = (id: string) => `#chat=${encodeURIComponent(id)}`;
export function floatingChatId(hash: string) {
  if (!hash.startsWith('#chat=')) return undefined;
  try {
    const id = decodeURIComponent(hash.slice(6));
    return id && id.length <= 150 ? id : undefined;
  } catch {
    return undefined;
  }
}
