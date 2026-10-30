import React, { useId, useLayoutEffect, useRef } from 'react';
import {
  FileDiff,
  FolderOpen,
  Globe,
  Info,
  Maximize2,
  Minimize2,
  Plus,
  Terminal,
  X,
} from 'lucide-react';
import { navigateTabs } from './tab-keyboard';
import './workspace-dock.css';

export type ToolView = 'details' | 'files' | 'changes' | 'terminal' | 'browser';
const tools = [
  { id: 'terminal', name: 'Terminal', icon: Terminal, hint: 'Consola del proyecto' },
  { id: 'browser', name: 'Navegador', icon: Globe, hint: 'Web y vistas previas' },
  { id: 'files', name: 'Archivos', icon: FolderOpen, hint: 'Explorar y leer' },
  { id: 'changes', name: 'Cambios', icon: FileDiff, hint: 'Revisar el diff' },
  { id: 'details', name: 'Información', icon: Info, hint: 'Chat, contexto y repositorio' },
] as const;

export function WorkspaceDock({
  active,
  tabs,
  launcher,
  expanded,
  onSelect,
  onCloseTab,
  onLauncher,
  onExpand,
  onHide,
  children,
}: {
  active: ToolView;
  tabs: ToolView[];
  launcher: boolean;
  expanded: boolean;
  onSelect: (view: ToolView) => void;
  onCloseTab: (view: ToolView) => void;
  onLauncher: () => void;
  onExpand: () => void;
  onHide: () => void;
  children: React.ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const restoreTabFocus = useRef(false);
  useLayoutEffect(() => {
    // A narrow dock scrolls its tabs: keep the active one visible without scrolling the page.
    const strip = root.current?.querySelector<HTMLElement>('.dock-tabs');
    const tab = strip?.querySelector<HTMLElement>('.dock-tab.selected');
    if (strip && tab) {
      if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
      else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth)
        strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
    }
    if (!restoreTabFocus.current) return;
    restoreTabFocus.current = false;
    root.current?.querySelector<HTMLButtonElement>('[role="tab"][tabindex="0"]')?.focus();
  }, [tabs, active, launcher]);
  return (
    <div className="workspace-dock" ref={root}>
      <header className="dock-header">
        <div className="dock-tabs" role="tablist" aria-label="Herramientas abiertas">
          {tabs.map((tab) => {
            const tool = tools.find((item) => item.id === tab)!;
            const Icon = tool.icon;
            return (
              <div
                className={`dock-tab ${active === tab && !launcher ? 'selected' : ''}`}
                key={tab}
              >
                <button
                  role="tab"
                  id={`${id}-${tab}`}
                  aria-controls={`${id}-content`}
                  aria-selected={active === tab && !launcher}
                  tabIndex={active === tab ? 0 : -1}
                  onKeyDown={navigateTabs}
                  onClick={() => onSelect(tab)}
                  title={tool.name}
                >
                  <Icon size={14} />
                  <span>{tool.name}</span>
                </button>
                <button
                  className="dock-close-tab"
                  aria-label={`Cerrar pestaña ${tool.name}`}
                  title="Cerrar vista"
                  onClick={() => {
                    restoreTabFocus.current = true;
                    onCloseTab(tab);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          className="dock-icon"
          aria-label="Abrir herramienta"
          aria-pressed={launcher}
          onClick={onLauncher}
          title="Abrir herramienta"
        >
          <Plus size={16} />
        </button>
        <div className="dock-window-actions">
          <button
            className="dock-icon"
            aria-label={expanded ? 'Reducir panel' : 'Ampliar panel'}
            onClick={onExpand}
            title={expanded ? 'Reducir panel' : 'Ampliar panel'}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="dock-icon"
            aria-label="Ocultar panel de herramientas"
            onClick={onHide}
            title="Ocultar panel (Esc)"
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div
        id={`${id}-content`}
        className="dock-content"
        role={launcher ? 'region' : 'tabpanel'}
        aria-label={launcher ? 'Abrir herramienta' : undefined}
        aria-labelledby={launcher ? undefined : `${id}-${active}`}
      >
        {launcher && (
          <div className="dock-launcher">
            <h2>Herramientas</h2>
            <div>
              {tools.map(({ id, name, icon: Icon, hint }) => (
                <button key={id} onClick={() => onSelect(id)}>
                  <Icon size={17} />
                  <span>
                    {name}
                    <small>{hint}</small>
                  </span>
                  <Plus size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="dock-views" hidden={launcher}>
          {children}
        </div>
      </div>
    </div>
  );
}
