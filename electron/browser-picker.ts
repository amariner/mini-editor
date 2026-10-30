import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { BrowserElementSelection } from '../src/browser-selection';

const world = 1002;
const activePickers = new WeakMap<Electron.WebContents, { id: string; cancel: () => void }>();
const selectionSchema = z.object({
  url: z.string().max(8192),
  title: z.string().max(500),
  tag: z.string().max(100),
  selector: z.string().max(1500),
  text: z.string().max(600),
  frameUrl: z.string().max(8192).optional(),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});

// This function runs only in a sandboxed isolated world. The website receives no IPC bridge.
function installPicker(id: string) {
  const state = window as typeof window & {
    __deskCancelPicker?: () => void;
    __deskPickerId?: string;
  };
  state.__deskCancelPicker?.();
  state.__deskPickerId = id;
  return new Promise<BrowserElementSelection | null>((resolve) => {
    const host = document.createElement('div');
    host.setAttribute('data-agent-desk-picker', '');
    host.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;cursor:crosshair;margin:0;border:0;padding:0;width:auto;height:auto;background:transparent;outline:none;';
    host.popover = 'manual';
    host.tabIndex = -1;
    const previousFocus = document.activeElement as HTMLElement | null;
    const shadow = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;display:none;border:2px solid #818cf8;border-radius:4px;background:rgba(99,102,241,.12);box-sizing:border-box;pointer-events:none;';
    const label = document.createElement('div');
    label.style.cssText =
      'position:fixed;max-width:360px;padding:5px 9px;border-radius:6px;background:#3730a3;color:white;font:12px/1.4 system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
    label.textContent = 'Selecciona un elemento · Esc para cancelar';
    label.style.left = '12px';
    label.style.top = '12px';
    shadow.append(box, label);
    // Modal dialogs make the rest of the document inert. Keep the picker in the
    // current modal's subtree, then place it above native popovers in the top layer.
    const modal = [...document.querySelectorAll('dialog:modal')].at(-1);
    (modal ?? document.documentElement).append(host);
    host.showPopover();
    host.focus({ preventScroll: true });
    const cleanups: (() => void)[] = [];
    let finished = false;
    const finish = (value: BrowserElementSelection | null) => {
      if (finished) return;
      finished = true;
      cleanups.forEach((clean) => clean());
      host.remove();
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
      if (state.__deskPickerId === id) {
        delete state.__deskCancelPicker;
        delete state.__deskPickerId;
      }
      resolve(value);
    };
    state.__deskCancelPicker = () => finish(null);
    const selector = (element: Element) => {
      const parts: string[] = [];
      let node: Element | null = element;
      for (let depth = 0; node && depth < 6; depth++) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift('#' + CSS.escape(node.id));
          break;
        }
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((child) => child.tagName === node!.tagName)
          : [];
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        parts.unshift(part);
        const root = node.getRootNode() as ShadowRoot;
        if (!node.parentElement && root.host?.nodeType === 1) {
          parts.unshift('>>>');
          node = root.host;
        } else node = node.parentElement;
      }
      return parts
        .join(' > ')
        .replace(/ > >>> > /g, ' >>> ')
        .slice(0, 1500);
    };
    type Hit = { element: Element; doc: Document; rect: BrowserElementSelection['rect'] };
    // The layer receives every click, including clicks over foreign frames. Temporarily
    // exclude it only while hit-testing; no pointer event is ever sent to the target.
    const hitTest = (
      doc: Document,
      x: number,
      y: number,
      origin = { x: 0, y: 0 },
      scale = { x: 1, y: 1 },
      depth = 0,
    ): Hit | undefined => {
      if (depth > 8) return;
      let element = doc.elementFromPoint(x, y);
      for (let level = 0; element?.shadowRoot && level < 16; level++) {
        const inner = element.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === element) break;
        element = inner;
      }
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (element.tagName.toLowerCase() === 'iframe') {
        const frame = element as HTMLIFrameElement;
        try {
          const child = frame.contentDocument;
          const sx = rect.width / (frame.offsetWidth || rect.width || 1);
          const sy = rect.height / (frame.offsetHeight || rect.height || 1);
          if (child && sx > 0 && sy > 0) {
            const left = rect.x + frame.clientLeft * sx;
            const top = rect.y + frame.clientTop * sy;
            const found = hitTest(
              child,
              (x - left) / sx,
              (y - top) / sy,
              { x: origin.x + left * scale.x, y: origin.y + top * scale.y },
              { x: scale.x * sx, y: scale.y * sy },
              depth + 1,
            );
            if (found) return found;
          }
        } catch {
          /* Cross-origin frames are selected as frames, never clicked through. */
        }
      }
      return {
        element,
        doc,
        rect: {
          x: origin.x + rect.x * scale.x,
          y: origin.y + rect.y * scale.y,
          width: rect.width * scale.x,
          height: rect.height * scale.y,
        },
      };
    };
    const target = (event: MouseEvent) => {
      host.style.pointerEvents = 'none';
      try {
        return hitTest(document, event.clientX, event.clientY);
      } finally {
        host.style.pointerEvents = 'auto';
      }
    };
    const move = (event: MouseEvent) => {
      const hit = target(event);
      if (!hit) return;
      const { element, rect } = hit;
      box.style.display = 'block';
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      label.textContent = `${element.tagName.toLowerCase()} · Clic para añadir al chat · Esc cancela`;
      label.style.left = `${Math.max(4, Math.min(rect.x, window.innerWidth - 330))}px`;
      label.style.top = `${Math.max(4, rect.y > 36 ? rect.y - 32 : rect.y + Math.min(rect.height, 40) + 4)}px`;
    };
    const block = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const click = (event: MouseEvent) => {
      block(event);
      const hit = target(event);
      if (!hit) return;
      const { element, doc, rect } = hit;
      finish({
        url: location.href,
        title: document.title.slice(0, 500),
        tag: element.tagName.toLowerCase(),
        selector: selector(element),
        // Never read input values, passwords, attributes containing tokens, or HTML.
        text: (
          (element as HTMLElement).innerText ||
          element.getAttribute('aria-label') ||
          ''
        ).slice(0, 600),
        ...(doc !== document ? { frameUrl: doc.URL } : {}),
        rect,
      });
    };
    const key = (event: KeyboardEvent) => {
      block(event);
      if (event.key === 'Escape') finish(null);
    };
    host.addEventListener('mousemove', move, true);
    host.addEventListener('click', click, true);
    host.addEventListener('keydown', key, true);
    const blockedEvents = [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'dblclick',
      'contextmenu',
    ];
    for (const event of blockedEvents) host.addEventListener(event, block, true);
    cleanups.push(() => {
      host.removeEventListener('mousemove', move, true);
      host.removeEventListener('click', click, true);
      host.removeEventListener('keydown', key, true);
      for (const event of blockedEvents) host.removeEventListener(event, block, true);
    });
  });
}

async function clearPicker(wc: Electron.WebContents, id: string) {
  if (wc.isDestroyed()) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    // A stalled page must not keep the browser toolbar busy after cancellation.
    await Promise.race([
      wc
        .executeJavaScriptInIsolatedWorld(world, [
          {
            code: `if(window.__deskPickerId===${JSON.stringify(id)})window.__deskCancelPicker?.()`,
          },
        ])
        .catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cancelBrowserPick(wc: Electron.WebContents) {
  const active = activePickers.get(wc);
  if (!active) return;
  active.cancel();
  await clearPicker(wc, active.id);
}

export async function pickBrowserElement(
  wc: Electron.WebContents,
): Promise<BrowserElementSelection | null> {
  if (wc.isDestroyed()) return null;
  activePickers.get(wc)?.cancel();
  const id = randomUUID();
  let cancel!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    cancel = () => resolve(null);
  });
  activePickers.set(wc, { id, cancel });
  const timer = setTimeout(cancel, 90000);
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) cancel();
  };
  wc.on('did-start-navigation', navigation);
  wc.once('destroyed', cancel);
  try {
    const result = await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(
        world,
        [{ code: `(${installPicker.toString()})(${JSON.stringify(id)})` }],
        true,
      ),
      cancelled,
    ]);
    return result === null ? null : selectionSchema.parse(result);
  } finally {
    clearTimeout(timer);
    wc.removeListener('did-start-navigation', navigation);
    wc.removeListener('destroyed', cancel);
    if (activePickers.get(wc)?.id === id) activePickers.delete(wc);
    await clearPicker(wc, id);
  }
}
