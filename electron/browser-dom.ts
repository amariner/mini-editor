/** Runs only in a dedicated isolated world of a sandboxed browser tab. No page JS is accepted. */
export function browserDOM(input: {
  action: 'inspect' | 'point' | 'cursor' | 'fill' | 'select' | 'scroll' | 'viewport' | 'check';
  sequence?: number;
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  value?: string;
  deltaX?: number;
  deltaY?: number;
  label?: string;
  checked?: boolean;
  scrollIntoView?: boolean;
}) {
  const state = ((window as any).__deskAutomation ??= {
    elements: new Map<string, Element>(),
  });
  const viewport = () => ({ width: innerWidth, height: innerHeight });
  const label = (el: Element) => {
    const labelledBy = el
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    const labels = (el as HTMLInputElement).labels;
    return (
      el.getAttribute('aria-label') ||
      labelledBy ||
      (labels ? [...labels].map((label) => label.textContent).join(' ') : '') ||
      (el as HTMLElement).innerText ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      ''
    )
      .trim()
      .slice(0, 180);
  };
  const offset = (el: Element) => {
    let x = 0,
      y = 0;
    let owner = el.ownerDocument.defaultView;
    while (owner && owner !== window) {
      const frame = owner.frameElement;
      if (!frame) break;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
      owner = frame.ownerDocument.defaultView;
    }
    return { x, y };
  };
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect(),
      o = offset(el);
    return { x: r.left + o.x, y: r.top + o.y, width: r.width, height: r.height };
  };
  const visible = (el: Element) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el);
    return (
      el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    );
  };
  const resolve = () => {
    const el = state.elements.get(input.ref) as Element | undefined;
    if (!el?.isConnected) throw new Error('Referencia caducada. Vuelve a inspeccionar la página.');
    return el;
  };
  const editable = (el: Element) => {
    if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true')
      throw new Error('El elemento está deshabilitado.');
    if ((el as HTMLInputElement).readOnly) throw new Error('El campo es de solo lectura.');
    if (el.tagName === 'INPUT' && ['file', 'password'].includes((el as HTMLInputElement).type))
      throw new Error('Este campo requiere intervención del usuario.');
  };
  const checkedState = (el: Element): boolean | 'mixed' | undefined => {
    if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes((el as HTMLInputElement).type))
      return (el as HTMLInputElement).indeterminate ? 'mixed' : (el as HTMLInputElement).checked;
    if (
      ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(
        el.getAttribute('role') ?? '',
      )
    ) {
      const checked = el.getAttribute('aria-checked');
      return checked === 'mixed' ? 'mixed' : checked === 'true';
    }
    return undefined;
  };
  const point = (el?: Element) => {
    if (!el) {
      const x = input.x!,
        y = input.y!;
      if (!(x >= 0 && x < innerWidth && y >= 0 && y < innerHeight))
        throw new Error('Coordenadas fuera de la ventana. Usa viewport de inspect o screenshot.');
      return { x, y, label: input.label ?? 'Agente' };
    }
    if (!visible(el)) throw new Error('El elemento ya no es visible. Vuelve a inspeccionar.');
    if ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true')
      throw new Error('El elemento está deshabilitado.');
    if (input.scrollIntoView !== false) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      let owner = el.ownerDocument.defaultView;
      while (owner && owner !== window) {
        const frame = owner.frameElement;
        if (!frame) break;
        frame.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        owner = frame.ownerDocument.defaultView;
      }
    }
    const r = rect(el);
    const left = Math.max(0, r.x),
      top = Math.max(0, r.y);
    const right = Math.min(innerWidth, r.x + r.width),
      bottom = Math.min(innerHeight, r.y + r.height);
    if (right <= left || bottom <= top) throw new Error('El elemento está fuera de la ventana.');
    // Test the actual target, including open shadow trees and enclosing frames. Never click
    // through a modal or cookie banner just because the old ref still exists underneath it.
    const hit = (x: number, y: number) => {
      let root: Document | ShadowRoot = document;
      let current: Element | null = root.elementFromPoint(x, y);
      let localX = x,
        localY = y;
      for (let depth = 0; current && depth < 30; depth++) {
        if (current === el || el.contains(current)) return true;
        if (current.shadowRoot) {
          root = current.shadowRoot;
          const next = root.elementFromPoint(localX, localY);
          if (!next || next === current) break;
          current = next;
        } else if (current.tagName === 'IFRAME') {
          const frame = current as HTMLIFrameElement;
          let doc: Document | null;
          try {
            doc = frame.contentDocument;
          } catch {
            break;
          }
          if (!doc) break;
          const bounds = frame.getBoundingClientRect();
          localX -= bounds.left + frame.clientLeft;
          localY -= bounds.top + frame.clientTop;
          root = doc;
          current = root.elementFromPoint(localX, localY);
        } else break;
      }
      return false;
    };
    const candidates = [
      [(left + right) / 2, (top + bottom) / 2],
      [left + Math.min(4, (right - left) / 2), top + Math.min(4, (bottom - top) / 2)],
      [right - Math.min(4, (right - left) / 2), bottom - Math.min(4, (bottom - top) / 2)],
    ];
    const found = candidates.find(([x, y]) => hit(x, y));
    if (!found)
      throw new Error(
        'Otro elemento cubre el objetivo. Inspecciona o captura la página para resolverlo.',
      );
    return { x: found[0], y: found[1], label: label(el), rect: r };
  };
  const cursor = (target: ReturnType<typeof point>) => {
    if (!state.overlay?.isConnected) {
      const host = document.createElement('div');
      host.setAttribute('data-agent-desk-cursor', '');
      host.style.cssText =
        'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;border:0!important;padding:0!important;background:transparent!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;';
      host.popover = 'manual';
      host.setAttribute('aria-hidden', 'true');
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>:host{pointer-events:none!important}:host::backdrop{background:transparent;pointer-events:none!important}*{box-sizing:border-box;pointer-events:none!important}.cursor{position:fixed;top:0;left:0;width:24px;height:28px;filter:drop-shadow(0 2px 3px #0006);transition:transform .18s ease-out;will-change:transform}.label{position:absolute;left:22px;top:25px;background:#315ae8;color:white;padding:4px 7px;border-radius:5px;font:11px/1.3 system-ui;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.target{position:fixed;border:2px solid #5e81ff;border-radius:5px;background:#6485ff16;transition:all .16s ease-out}.halo{position:absolute;width:32px;height:32px;left:-12px;top:-12px;border:2px solid #7896ff;border-radius:50%;background:#6c8aff22}</style><div class="target"></div><div class="cursor"><div class="halo"></div><svg width="24" height="28" viewBox="0 0 24 28"><path d="M2 1L20 17L12 18L8 26L2 1Z" fill="#315ae8" stroke="white" stroke-width="1.8"/></svg><span class="label"></span></div>`;
      state.overlay = host;
      state.cursor = shadow.querySelector('.cursor');
      state.highlight = shadow.querySelector('.target');
      state.caption = shadow.querySelector('.label');
      document.documentElement.append(host);
      // Top-layer placement keeps the cursor visible over native dialogs without taking focus.
      try {
        host.showPopover();
      } catch {
        /* A detached document keeps the ordinary overlay. */
      }
    }
    clearTimeout(state.hideTimer);
    state.overlay.style.opacity = '1';
    state.cursor.style.transform = `translate(${target.x}px,${target.y}px)`;
    state.caption.textContent = input.label || target.label || 'Agente';
    const r = target.rect;
    state.highlight.style.display = r ? 'block' : 'none';
    if (r)
      Object.assign(state.highlight.style, {
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    state.hideTimer = setTimeout(() => {
      if (state.overlay) state.overlay.style.opacity = '0';
    }, 2500);
    return target;
  };
  if (input.action === 'viewport') return viewport();
  if (input.action === 'inspect') {
    state.elements = new Map();
    let n = (input.sequence ?? 0) * 1000;
    const elements: any[] = [];
    const frames: any[] = [];
    const texts = [(document.body?.innerText ?? '').slice(0, 18000)];
    const visited = new Set<Document | ShadowRoot>();
    const scan = (root: Document | ShadowRoot, depth = 0) => {
      if (visited.has(root) || depth > 12 || visited.size > 100) return;
      visited.add(root);
      for (const el of root.querySelectorAll('*')) {
        if (el === state.overlay) continue;
        if (
          elements.length < 400 &&
          (visible(el) || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file')) &&
          el.matches(
            'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="slider"],[draggable="true"],[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])',
          )
        ) {
          const ref = 'e' + ++n;
          state.elements.set(ref, el);
          const select = el.tagName === 'SELECT' ? (el as HTMLSelectElement) : undefined;
          elements.push({
            ref,
            tag: el.tagName.toLowerCase(),
            label: label(el),
            type: el.getAttribute('type'),
            role: el.getAttribute('role'),
            disabled:
              !!(el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true',
            rect: rect(el),
            ...(el.tagName === 'A'
              ? {
                  href: (el as HTMLAnchorElement).href,
                  ...(el.hasAttribute('download') ? { download: el.getAttribute('download') } : {}),
                }
              : {}),
            ...(checkedState(el) !== undefined ? { checked: checkedState(el) } : {}),
            ...(el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file'
              ? {
                  accept: (el as HTMLInputElement).accept,
                  multiple: (el as HTMLInputElement).multiple,
                  files: [...((el as HTMLInputElement).files ?? [])].map((file) => ({
                    name: file.name,
                    size: file.size,
                  })),
                  hidden: !visible(el),
                }
              : {}),
            ...(el.getAttribute('draggable') === 'true' ? { draggable: true } : {}),
            ...(select
              ? {
                  options: [...select.options].slice(0, 100).map((o) => ({
                    value: o.value,
                    label: o.label,
                    selected: o.selected,
                    disabled: o.disabled,
                  })),
                }
              : {}),
          });
        }
        if (el.shadowRoot) {
          texts.push((el.shadowRoot.textContent ?? '').slice(0, 4000));
          scan(el.shadowRoot, depth + 1);
        }
        if (el.tagName === 'IFRAME' && visible(el)) {
          let doc: Document | null = null;
          try {
            doc = (el as HTMLIFrameElement).contentDocument;
          } catch {
            /* Cross-origin is accessed by viewport coordinates only. */
          }
          frames.push({
            title: el.getAttribute('title') ?? '',
            src: el.getAttribute('src') ?? '',
            accessible: !!doc,
            rect: rect(el),
          });
          if (doc) {
            texts.push((doc.body?.innerText ?? '').slice(0, 6000));
            scan(doc, depth + 1);
          }
        }
      }
    };
    scan(document);
    return {
      url: location.href,
      title: document.title,
      viewport: viewport(),
      text: texts.join('\n').slice(0, 24000),
      elements,
      frames,
      forms: [...document.forms]
        .slice(0, 30)
        .map((form) => ({ action: form.action, method: form.method, enctype: form.enctype })),
      truncated: elements.length >= 400,
    };
  }
  if (input.action === 'point' || input.action === 'cursor')
    return cursor(point(input.ref ? resolve() : undefined));
  if (input.action === 'check') {
    const el = resolve();
    const checked = checkedState(el);
    if (checked === undefined)
      throw new Error('check requiere una casilla, un interruptor o una opción de radio.');
    const needsClick = input.checked !== undefined && checked !== input.checked;
    if (
      needsClick &&
      input.checked === false &&
      ((el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'radio') ||
        el.getAttribute('role') === 'radio')
    )
      throw new Error('Para cambiar una opción de radio, selecciona otra opción de su grupo.');
    return { ...(needsClick ? cursor(point(el)) : { label: label(el) }), checked, needsClick };
  }
  if (input.action === 'scroll') {
    const el = input.ref ? resolve() : document.scrollingElement;
    if (!el) return { ok: true };
    if (input.ref) cursor(point(el));
    el.scrollBy({ left: input.deltaX ?? 0, top: input.deltaY ?? 0, behavior: 'instant' });
    return { ok: true, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
  }
  const el = resolve();
  editable(el);
  const target = cursor(point(el));
  (el as HTMLElement).focus();
  const owner = el.ownerDocument.defaultView as any;
  const value = input.action === 'select' ? input.value! : input.text!;
  if (input.action === 'select' && el.tagName !== 'SELECT')
    throw new Error(
      'select requiere un selector HTML. Para listas personalizadas usa click y press.',
    );
  if (el.tagName === 'SELECT') {
    const select = el as HTMLSelectElement;
    const option = [...select.options].find((option) => option.value === value);
    if (
      !option ||
      option.disabled ||
      (option.parentElement?.tagName === 'OPTGROUP' &&
        (option.parentElement as HTMLOptGroupElement).disabled)
    )
      throw new Error('La opción no existe o está deshabilitada. Consulta options de inspect.');
  }
  if ((el as HTMLElement).isContentEditable) {
    // insertText preserves editing semantics, selection and framework beforeinput/input handlers.
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const selection = el.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return { ...target, insertText: value };
  }
  const proto =
    el.tagName === 'TEXTAREA'
      ? owner.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? owner.HTMLSelectElement.prototype
        : el.tagName === 'INPUT'
          ? owner.HTMLInputElement.prototype
          : undefined;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('El elemento no es editable.');
  setter.call(el, value);
  el.dispatchEvent(new owner.Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new owner.Event('change', { bubbles: true, composed: true }));
  return target;
}
