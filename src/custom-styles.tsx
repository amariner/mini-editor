import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Copy, RotateCcw, Save, Trash2 } from 'lucide-react';
/**
 * User CSS lives in an adopted stylesheet, which always cascades after the editor's own
 * styles: changing values or adding rules wins, and a partial paste cannot break the rest.
 * Themes are named copies of that CSS: the ones in /themes ship with the app, the rest are
 * saved locally.
 */
const KEY = 'agent-desk.styles.v1';
const THEMES_KEY = 'agent-desk.themes.v1';
const ACTIVE_KEY = 'agent-desk.styles.theme.v1';
export const STYLES_EVENT = 'agent-desk:styles';
const sheet = typeof CSSStyleSheet === 'function' ? new CSSStyleSheet() : undefined;
type SavedTheme = { id: string; name: string; css: string };
// Shipped themes are separate chunks, loaded only when chosen.
const shipped = import.meta.glob<string>('../themes/*.css', { query: '?raw', import: 'default' });
const NAMES: Record<string, string> = {
  'terminal-8bit': 'Terminal 8-bit',
  'circo-cosmico': 'Circo Cósmico',
};
const builtinThemes = Object.entries(shipped)
  .map(([path, load]) => {
    const file = path.slice(path.lastIndexOf('/') + 1, -'.css'.length);
    const name = NAMES[file] ?? file.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return { id: `builtin:${file}`, name, load };
  })
  .sort((a, b) => a.name.localeCompare(b.name, 'es'));
function read(key: string) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
export const savedStyles = () => read(KEY);
const activeTheme = () => read(ACTIVE_KEY) || undefined;
function savedThemes(): SavedTheme[] {
  try {
    const list = JSON.parse(read(THEMES_KEY) || '[]');
    return Array.isArray(list)
      ? list.filter(
          (t) =>
            t &&
            typeof t.id === 'string' &&
            typeof t.name === 'string' &&
            typeof t.css === 'string',
        )
      : [];
  } catch {
    return [];
  }
}
const writeThemes = (themes: SavedTheme[]) =>
  localStorage.setItem(THEMES_KEY, JSON.stringify(themes));
export function applyStyles(css: string) {
  if (!sheet) return;
  sheet.replaceSync(css);
  const others = document.adoptedStyleSheets.filter((s) => s !== sheet);
  document.adoptedStyleSheets = css.trim() ? [...others, sheet] : others;
}
function store(css: string, themeId?: string) {
  if (css) localStorage.setItem(KEY, css);
  else localStorage.removeItem(KEY);
  if (css && themeId) localStorage.setItem(ACTIVE_KEY, themeId);
  else localStorage.removeItem(ACTIVE_KEY);
  applyStyles(css);
  window.dispatchEvent(new Event(STYLES_EVENT));
}
export function resetStyles() {
  try {
    store('');
  } catch {
    applyStyles('');
  }
}
// Other native windows share storage, but each owns its adopted stylesheet.
window.addEventListener('storage', (event) => {
  if (event.storageArea !== localStorage) return;
  if (event.key === null || event.key === KEY) applyStyles(savedStyles());
  if (event.key === null || [KEY, THEMES_KEY, ACTIVE_KEY].includes(event.key))
    window.dispatchEvent(new Event(STYLES_EVENT));
});
function ruleCount(css: string) {
  const probe = new CSSStyleSheet();
  probe.replaceSync(css);
  return probe.cssRules.length;
}
type CssEdit = { value: string; start: number; end: number; scrollTop: number };
const cssEdit = (input: HTMLTextAreaElement): CssEdit => ({
  value: input.value,
  start: input.selectionStart,
  end: input.selectionEnd,
  scrollTop: input.scrollTop,
});
function useCssInput(
  value: string,
  change: (value: string) => void,
  source: string,
  version: number,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const changeRef = useRef(change);
  changeRef.current = change;
  const history = useRef({
    current: { value, start: 0, end: 0, scrollTop: 0 } as CssEdit,
    past: [] as CssEdit[],
    future: [] as CssEdit[],
    before: undefined as CssEdit | undefined,
    restore: undefined as CssEdit | undefined,
    group: '',
    time: 0,
  });
  const documentRef = useRef({ source, version });
  useLayoutEffect(() => {
    const state = history.current;
    const replaced =
      documentRef.current.source !== source || documentRef.current.version !== version;
    documentRef.current = { source, version };
    // Reset only for an external document change. Rapid menu actions may reach the
    // next history entry before React commits the preceding draft.
    if (replaced && state.current.value !== value) {
      state.current = ref.current
        ? cssEdit(ref.current)
        : { value, start: 0, end: 0, scrollTop: 0 };
      state.past = [];
      state.future = [];
      state.before = undefined;
      state.restore = undefined;
      state.group = '';
    } else if (ref.current && state.restore?.value === value) {
      ref.current.setSelectionRange(state.restore.start, state.restore.end);
      ref.current.scrollTop = state.restore.scrollTop;
      state.restore = undefined;
    }
  }, [value, source, version]);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const state = history.current;
    const apply = (edit: CssEdit) => {
      input.value = edit.value;
      input.setSelectionRange(edit.start, edit.end);
      input.scrollTop = edit.scrollTop;
      state.current = edit;
      state.before = undefined;
      state.restore = edit;
      state.group = '';
      changeRef.current(edit.value);
    };
    const undo = (redo: boolean) => {
      const from = redo ? state.future : state.past;
      const edit = from.pop();
      if (!edit) return;
      (redo ? state.past : state.future).push(cssEdit(input));
      apply(edit);
    };
    const record = (before: CssEdit, next: CssEdit, group = '') => {
      if (before.value === next.value) return;
      const time = Date.now();
      const continuous =
        group &&
        group === state.group &&
        time - state.time < 1000 &&
        before.start === state.current.start &&
        before.end === state.current.end;
      if (!continuous) {
        state.past.push(before);
        if (state.past.length > 60) state.past.shift();
      }
      state.future = [];
      state.current = next;
      state.before = undefined;
      state.restore = undefined;
      state.group = group;
      state.time = time;
      changeRef.current(next.value);
    };
    const insert = (event: Event, text: string | null) => {
      if (!text || text.length < 4096 || !/[\r\n]/.test(text)) return false;
      event.preventDefault();
      const before = cssEdit(input);
      // Blink's native insertion becomes quadratic for thousands of lines. Assigning
      // the completed value avoids that work; local history also covers this paste.
      const normalized = text.replace(/\r\n?/g, '\n');
      input.value =
        before.value.slice(0, before.start) + normalized + before.value.slice(before.end);
      input.setSelectionRange(before.start + normalized.length, before.start + normalized.length);
      record(before, cssEdit(input));
      return true;
    };
    const beforeInput = (event: Event) => {
      const edit = event as InputEvent;
      if (edit.inputType === 'historyUndo' || edit.inputType === 'historyRedo') {
        event.preventDefault();
        undo(edit.inputType === 'historyRedo');
        return;
      }
      if (
        !edit.isComposing &&
        insert(event, edit.data ?? edit.dataTransfer?.getData('text/plain') ?? null)
      )
        return;
      state.before = cssEdit(input);
    };
    const onInput = (event: Event) => {
      const edit = event as InputEvent;
      const before = state.before ?? state.current;
      const group =
        !edit.isComposing && before.start === before.end
          ? edit.inputType === 'insertText' && edit.data?.length === 1
            ? 'typing'
            : /^deleteContent(Backward|Forward)$/.test(edit.inputType)
              ? edit.inputType
              : ''
          : '';
      record(before, cssEdit(input), group);
    };
    const paste = (event: ClipboardEvent) => {
      insert(event, event.clipboardData?.getData('text/plain') ?? null);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && !(key === 'y' && event.ctrlKey)) return;
      event.preventDefault();
      undo(key === 'y' || event.shiftKey);
    };
    input.addEventListener('beforeinput', beforeInput);
    input.addEventListener('input', onInput);
    input.addEventListener('paste', paste);
    input.addEventListener('keydown', keyDown);
    return () => {
      input.removeEventListener('beforeinput', beforeInput);
      input.removeEventListener('input', onInput);
      input.removeEventListener('paste', paste);
      input.removeEventListener('keydown', keyDown);
    };
  }, []);
  return ref;
}
export function StyleEditor() {
  const [base, setBase] = useState<string>();
  const [saved, setSaved] = useState(savedStyles);
  const [active, setActive] = useState(activeTheme);
  const [themes, setThemes] = useState(savedThemes);
  const [draft, setDraft] = useState<string>();
  const [naming, setNaming] = useState<string>();
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>();
  const documentVersion = useRef(0);
  useEffect(() => {
    let alive = true;
    // Loaded on demand: the editor's source CSS is only needed while this panel is open.
    void Promise.all([
      import('./chat-state-mark.css?raw'),
      import('./chat-detach-drag.css?raw'),
      import('./chat-navigation.css?raw'),
      import('./git-dock.css?raw'),
      import('@xterm/xterm/css/xterm.css?raw'),
      import('./style.css?raw'),
      import('./shell-polish.css?raw'),
      import('./settings-polish.css?raw'),
      import('./chat-polish.css?raw'),
      import('./multichat-polish.css?raw'),
      import('./browser-polish.css?raw'),
      import('./attention.css?raw'),
      import('./motion.css?raw'),
      import('./floating-chat.css?raw'),
      import('./onboarding.css?raw'),
      import('./project-navigation.css?raw'),
      import('./composer-dock.css?raw'),
    ]).then((styles) => alive && setBase(styles.map((style) => style.default).join('\n\n')));
    const sync = () => {
      documentVersion.current++;
      setSaved(savedStyles());
      setActive(activeTheme());
      setThemes(savedThemes());
      setDraft(undefined);
    };
    window.addEventListener(STYLES_EVENT, sync);
    return () => {
      alive = false;
      window.removeEventListener(STYLES_EVENT, sync);
    };
  }, []);
  const current = saved || base || '';
  const value = draft ?? current;
  const inputRef = useCssInput(value, setDraft, current, documentVersion.current);
  const dirty = draft !== undefined && draft !== current;
  const own = themes.find((t) => t.id === active);
  const activeName = own?.name ?? builtinThemes.find((t) => t.id === active)?.name;
  const selected = !saved ? '' : activeName ? active! : 'custom';
  const custom = !!value.trim() && value.trim() !== (base ?? '').trim();
  const say = (ok: boolean, text: string) => {
    setNotice({ ok, text });
    setTimeout(() => setNotice(undefined), 2600);
  };
  const valid = (css: string) => {
    if (!css.trim() || ruleCount(css)) return true;
    say(false, 'No se ha reconocido ninguna regla CSS. Revisa el texto pegado.');
    return false;
  };
  const apply = (css: string, themeId?: string) => {
    try {
      store(css, themeId);
      return true;
    } catch {
      say(false, 'No se han podido guardar los estilos.');
      return false;
    }
  };
  const keepThemes = (next: SavedTheme[]) => {
    try {
      writeThemes(next);
      return true;
    } catch {
      say(false, 'No queda espacio para guardar temas. Elimina alguno.');
      return false;
    }
  };
  const choose = async (id: string) => {
    if (!id) {
      resetStyles();
      say(true, 'Estilos originales restaurados.');
      return;
    }
    const mine = themes.find((t) => t.id === id);
    const builtin = builtinThemes.find((t) => t.id === id);
    const css = mine?.css ?? (await builtin?.load());
    if (css !== undefined && apply(css, id))
      say(true, `Tema «${mine?.name ?? builtin?.name}» aplicado.`);
  };
  const save = () => {
    const css = custom ? value : '';
    if (!valid(css)) return;
    // Editing one of your themes updates it; anything else becomes unnamed custom styles.
    if (own && css) {
      if (
        keepThemes(themes.map((t) => (t.id === own.id ? { ...t, css } : t))) &&
        apply(css, own.id)
      )
        say(true, `Tema «${own.name}» actualizado.`);
      return;
    }
    if (apply(css))
      say(
        true,
        css ? 'Estilos guardados y aplicados.' : 'Sin cambios: se usan los estilos originales.',
      );
  };
  const saveAs = (input: string) => {
    const name = input.trim().slice(0, 40);
    if (!name || !valid(value)) return;
    const existing = themes.find(
      (t) => t.name.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'),
    );
    const theme = { id: existing?.id ?? `theme-${Date.now().toString(36)}`, name, css: value };
    const next = existing
      ? themes.map((t) => (t.id === existing.id ? theme : t))
      : [...themes, theme];
    if (!keepThemes(next) || !apply(value, theme.id)) return;
    setNaming(undefined);
    say(true, existing ? `Tema «${name}» sustituido.` : `Tema «${name}» guardado.`);
  };
  const remove = () => {
    if (!own || !keepThemes(themes.filter((t) => t.id !== own.id))) return;
    resetStyles();
    say(true, `Tema «${own.name}» eliminado. Vuelven los estilos originales.`);
  };
  const status = notice && (
    <span className={`style-notice ${notice.ok ? '' : 'error'}`} role="status">
      {notice.ok && <Check size={12} />} {notice.text}
    </span>
  );
  return (
    <section className="style-editor" aria-labelledby="style-editor-title">
      <header>
        <h3 id="style-editor-title">Estilos (CSS)</h3>
        <span className={`style-state ${saved ? 'custom' : ''}`}>
          {dirty
            ? 'Cambios sin guardar'
            : activeName
              ? `Tema: ${activeName}`
              : saved
                ? 'Usando tus estilos'
                : 'Estilos originales'}
        </span>
      </header>
      <div className="style-themes">
        <label htmlFor="style-theme">Tema</label>
        <select id="style-theme" value={selected} onChange={(e) => void choose(e.target.value)}>
          <option value="">Original</option>
          {builtinThemes.length > 0 && (
            <optgroup label="Incluidos">
              {builtinThemes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
          {themes.length > 0 && (
            <optgroup label="Tus temas">
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
          {selected === 'custom' && (
            <option value="custom" disabled>
              Personalizado
            </option>
          )}
        </select>
        <button
          className="quiet"
          disabled={!own}
          title={own ? `Eliminar «${own.name}»` : 'Solo se pueden eliminar tus temas'}
          onClick={remove}
        >
          <Trash2 size={13} /> Eliminar
        </button>
      </div>
      <p className="muted">
        Elige un tema o copia el CSS del editor, modifícalo y pégalo aquí. Al guardar se aplica por
        encima de los estilos originales: cambia los valores en el propio texto o añade reglas con
        el mismo selector (borrar una regla no la quita). Si algo queda ilegible, usa Ventana →
        Restablecer estilos de la interfaz.
      </p>
      <textarea
        ref={inputRef}
        aria-label="CSS del editor"
        spellCheck={false}
        wrap="off"
        value={value}
        placeholder={base === undefined ? 'Cargando estilos…' : ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (dirty) save();
          }
        }}
      />
      {naming !== undefined ? (
        <form
          className="style-actions"
          onSubmit={(e) => {
            e.preventDefault();
            saveAs(naming);
          }}
        >
          <input
            autoFocus
            aria-label="Nombre del tema"
            placeholder="Nombre del tema"
            maxLength={40}
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNaming(undefined);
              }
            }}
          />
          {status}
          <button type="button" className="quiet" onClick={() => setNaming(undefined)}>
            Cancelar
          </button>
          <button type="submit" className="primary small" disabled={!naming.trim()}>
            <Save size={13} /> Guardar tema
          </button>
        </form>
      ) : (
        <div className="style-actions">
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                say(true, 'CSS copiado.');
              } catch {
                say(false, 'No se ha podido copiar. Selecciona el texto y usa ⌘C.');
              }
            }}
          >
            <Copy size={13} /> Copiar
          </button>
          {status}
          <button
            className="quiet"
            disabled={!saved && !dirty}
            onClick={() => {
              resetStyles();
              say(true, 'Estilos originales restaurados.');
            }}
          >
            <RotateCcw size={13} /> Restablecer
          </button>
          <button
            disabled={!custom}
            title="Guarda este CSS con un nombre para volver a él cuando quieras"
            onClick={() => setNaming(own?.name ?? '')}
          >
            Guardar como tema…
          </button>
          <button className="primary small" disabled={!dirty} onClick={save}>
            <Save size={13} /> Guardar
          </button>
        </div>
      )}
    </section>
  );
}
