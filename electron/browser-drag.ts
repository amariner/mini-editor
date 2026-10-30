type Point = { x: number; y: number };

/** A native pointer gesture also carries Chromium's HTML drag data when the page initiates it. */
export async function dragBrowserPointer(wc: Electron.WebContents, from: Point, to: Point) {
  const attached = wc.debugger.isAttached();
  let dragData: unknown;
  let entered = false;
  const message = (_event: unknown, method: string, params: any) => {
    if (method === 'Input.dragIntercepted') dragData = params.data;
  };
  try {
    if (!attached) wc.debugger.attach('1.3');
    wc.debugger.on('message', message);
    await wc.debugger.sendCommand('Input.setInterceptDrags', { enabled: true });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...from,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 16; step++) {
      const point = {
        x: from.x + ((to.x - from.x) * step) / 16,
        y: from.y + ((to.y - from.y) * step) / 16,
      };
      if (dragData) {
        await wc.debugger.sendCommand('Input.dispatchDragEvent', {
          type: entered ? 'dragOver' : 'dragEnter',
          ...point,
          data: dragData,
        });
        entered = true;
      } else {
        await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...point,
          button: 'left',
          buttons: 1,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (dragData) {
      await wc.debugger.sendCommand('Input.dispatchDragEvent', {
        type: 'dragEnter',
        ...to,
        data: dragData,
      });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', {
        type: 'dragOver',
        ...to,
        data: dragData,
      });
      await wc.debugger.sendCommand('Input.dispatchDragEvent', {
        type: 'drop',
        ...to,
        data: dragData,
      });
    }
    return { ok: true, kind: dragData ? 'html' : 'pointer' };
  } finally {
    if (!wc.isDestroyed() && wc.debugger.isAttached()) {
      await wc.debugger
        .sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...to,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => {});
      await wc.debugger.sendCommand('Input.setInterceptDrags', { enabled: false }).catch(() => {});
      wc.debugger.removeListener('message', message);
      if (!attached) wc.debugger.detach();
    }
  }
}
