import React, { useState } from 'react';
import { ProjectMark } from './project-mark';
import { Globe, Settings2, Sparkles } from 'lucide-react';

type InterfacePreferences = {
  projectIconSize: number;
  chatFontSize: number;
  chatColor: string | null;
  iconColor: string | null;
  textColor: string | null;
};
const defaults: InterfacePreferences = {
  projectIconSize: 20,
  chatFontSize: 13,
  chatColor: null,
  iconColor: null,
  textColor: null,
};
const storageKey = 'agent-desk.interface.v1';
const iconSizes = [14, 18, 20, 24, 28];
const fontSizes = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20];

function readPreferences(): InterfacePreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return {
      projectIconSize: iconSizes.includes(saved.projectIconSize)
        ? saved.projectIconSize
        : defaults.projectIconSize,
      chatFontSize: fontSizes.includes(saved.chatFontSize)
        ? saved.chatFontSize
        : defaults.chatFontSize,
      chatColor:
        typeof saved.chatColor === 'string' && /^#[\da-f]{6}$/i.test(saved.chatColor)
          ? saved.chatColor
          : null,
      iconColor:
        typeof saved.iconColor === 'string' && /^#[\da-f]{6}$/i.test(saved.iconColor)
          ? saved.iconColor
          : null,
      textColor:
        typeof saved.textColor === 'string' && /^#[\da-f]{6}$/i.test(saved.textColor)
          ? saved.textColor
          : null,
    };
  } catch {
    return { ...defaults };
  }
}

export function useInterfacePreferences(onError: (message: string) => void) {
  const [preferences, setPreferences] = useState(readPreferences);
  const update = (next: InterfacePreferences) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setPreferences(next);
    } catch {
      onError('No se han podido guardar los ajustes de interfaz.');
    }
  };
  const style = {
    '--project-icon-size': `${preferences.projectIconSize}px`,
    '--chat-font-size': `${preferences.chatFontSize}px`,
    '--chat-color': preferences.chatColor ?? undefined,
    '--ui-icon-color': preferences.iconColor ?? undefined,
    '--ui-text-color': preferences.textColor ?? undefined,
  } as React.CSSProperties;
  return { preferences, update, style };
}

export function InterfaceSettings({
  preferences,
  update,
}: {
  preferences: InterfacePreferences;
  update: (next: InterfacePreferences) => void;
}) {
  return (
    <div className="interface-settings">
      <label className="interface-setting">
        <span>Iconos de proyectos</span>
        <select
          aria-label="Tamaño de los iconos de proyectos"
          value={preferences.projectIconSize}
          onChange={(e) => update({ ...preferences, projectIconSize: Number(e.target.value) })}
        >
          {iconSizes.map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
        </select>
      </label>
      <label className="interface-setting">
        <span>Letra del chat</span>
        <select
          aria-label="Tamaño de fuente del chat"
          value={preferences.chatFontSize}
          onChange={(e) => update({ ...preferences, chatFontSize: Number(e.target.value) })}
        >
          {fontSizes.map((size) => (
            <option key={size} value={size}>
              {size} px
            </option>
          ))}
        </select>
      </label>
      <div className="interface-setting">
        <label htmlFor="chat-font-color">Color del chat</label>
        <div className="interface-color">
          <button
            className={preferences.chatColor === null ? 'selected' : ''}
            aria-pressed={preferences.chatColor === null}
            onClick={() => update({ ...preferences, chatColor: null })}
          >
            Auto
          </button>
          <input
            id="chat-font-color"
            type="color"
            aria-label="Color de fuente del chat"
            value={preferences.chatColor ?? '#8f8f8c'}
            onChange={(e) => update({ ...preferences, chatColor: e.target.value })}
          />
        </div>
      </div>
      <div className="interface-setting">
        <label htmlFor="ui-icon-color">Color de los iconos</label>
        <div className="interface-color">
          <button
            className={preferences.iconColor === null ? 'selected' : ''}
            aria-label="Color automático de iconos"
            aria-pressed={preferences.iconColor === null}
            onClick={() => update({ ...preferences, iconColor: null })}
          >
            Auto
          </button>
          <input
            id="ui-icon-color"
            type="color"
            aria-label="Color de los iconos"
            value={preferences.iconColor ?? '#8f8f8c'}
            onChange={(e) => update({ ...preferences, iconColor: e.target.value })}
          />
        </div>
      </div>
      <div className="interface-setting">
        <label htmlFor="ui-text-color">Textos de la interfaz</label>
        <div className="interface-color">
          <button
            className={preferences.textColor === null ? 'selected' : ''}
            aria-label="Color automático de textos de la interfaz"
            aria-pressed={preferences.textColor === null}
            onClick={() => update({ ...preferences, textColor: null })}
          >
            Auto
          </button>
          <input
            id="ui-text-color"
            type="color"
            aria-label="Color de textos de la interfaz"
            value={preferences.textColor ?? '#8f8f8c'}
            onChange={(e) => update({ ...preferences, textColor: e.target.value })}
          />
        </div>
      </div>
      <div className="interface-preview" aria-label="Vista previa de la interfaz">
        <ProjectMark identity="interface-preview" />
        <div>
          <p>Todo listo para tu próxima idea.</p>
          <p>Una conversación a tu medida.</p>
          <div className="interface-icon-preview" aria-hidden="true">
            <Globe size={16} />
            <Sparkles size={16} />
            <Settings2 size={16} />
          </div>
        </div>
      </div>
      <button className="interface-reset" onClick={() => update({ ...defaults })}>
        Restablecer
      </button>
    </div>
  );
}
