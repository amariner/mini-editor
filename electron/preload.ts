import { contextBridge, ipcRenderer } from 'electron';
import type { DeskAPI, DeskEvent } from '../src/shared';
const api: DeskAPI = {
  invoke: (action) => ipcRenderer.invoke('desk:action', action),
  subscribe(fn) {
    const listener = (_event: unknown, data: DeskEvent) => fn(data);
    ipcRenderer.on('desk:event', listener);
    return () => ipcRenderer.removeListener('desk:event', listener);
  },
};
contextBridge.exposeInMainWorld('desk', api);
