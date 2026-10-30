import { contextBridge, ipcRenderer } from 'electron';

// Electron replaces window.prompt with a throwing stub. Expose only the ordinary
// synchronous string|null dialog operation; the page gets no general IPC or OS API.
contextBridge.exposeInMainWorld('__agentDeskPrompt', (message = '', initial = '') =>
  ipcRenderer.sendSync(
    'agent-desk:browser-prompt',
    String(message).slice(0, 5000),
    String(initial).slice(0, 20000),
  ),
);
contextBridge.executeInMainWorld({
  func: () => {
    window.prompt = (
      window as typeof window & { __agentDeskPrompt: typeof window.prompt }
    ).__agentDeskPrompt;
  },
});
