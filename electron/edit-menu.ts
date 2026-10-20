import { webContents, type MenuItemConstructorOptions, type WebContents } from 'electron';

// The CSS editor keeps its own history to support very large multiline pastes.
// Only dispatch into the trusted main renderer; browser tabs retain native editing.
const editorUndo = `(() => {
  const input = document.activeElement;
  if (!input?.matches('.style-editor textarea')) return false;
  const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`;
const editorRedo = `(() => {
  const input = document.activeElement;
  if (!input?.matches('.style-editor textarea')) return false;
  const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, cancelable: true });
  input.dispatchEvent(event);
  return event.defaultPrevented;
})()`;

export function editHistoryMenu(
  mainContents: () => WebContents | undefined,
): MenuItemConstructorOptions[] {
  const edit = async (redo: boolean) => {
    const focused = webContents.getFocusedWebContents();
    if (!focused || focused.isDestroyed()) return;
    if (focused === mainContents()) {
      try {
        if (await focused.executeJavaScript(redo ? editorRedo : editorUndo)) return;
      } catch {
        // A renderer navigating or closing can still use its native edit command.
      }
    }
    if (!focused.isDestroyed()) {
      if (redo) focused.redo();
      else focused.undo();
    }
  };
  return [
    {
      label: 'Deshacer',
      accelerator: 'CmdOrCtrl+Z',
      click: () => {
        void edit(false);
      },
    },
    {
      label: 'Rehacer',
      accelerator: process.platform === 'darwin' ? 'Cmd+Shift+Z' : 'Ctrl+Y',
      click: () => {
        void edit(true);
      },
    },
  ];
}
