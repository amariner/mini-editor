# Agent Desk

Aplicación local para macOS: una ventana Electron con tus proyectos, cuentas independientes de Claude Code y Codex (sin cuentas precreadas). Claude funciona como un **chat nativo equivalente a Claude Code** (streaming, herramientas, permisos, preguntas, comandos, modelo, permisos y esfuerzo desde el compositor) y conserva su terminal oficial como modo opcional. La interfaz está en español, con un diseño plano y claro.

## Arrancar

```bash
npm ci
npm run dev
```

`npm ci` instala localmente el paquete oficial de Claude Code, el Agent SDK de Claude y recompila `node-pty` para Electron. No instala herramientas globales ni copia configuraciones existentes. Requiere Node 22.12+ (probado con 26.8.1), npm y Git.

Compilación local sin servidor de desarrollo:

```bash
npm run build
npm start
```

`npm run dev` inicia Vite en `127.0.0.1:5173`, compila main/preload y abre Electron. React recarga en caliente. Los cambios en main/preload se recompilan y muestran **Actualización preparada**: detén las sesiones abiertas y pulsa **Actualizar aplicación** para reiniciar Electron conservando Vite. Nunca se reinician agentes automáticamente. La interfaz comprueba la versión del proceso principal antes de ejecutar funciones nuevas. Si ya tenías abierta una versión anterior sin este mecanismo, sal con **⌘Q** y ejecuta de nuevo `npm run dev`; cerrar solo la ventana mantiene el proceso antiguo vivo. Esta entrega no incluye instalador `.dmg`, firma ni notarización.

Codex se detecta en el PATH y dentro de ChatGPT.app (`/Applications`, `~/Applications`, `~/Aplicaciones`). También puedes seleccionar su ejecutable en **Ajustes → Herramientas y datos locales**.

## Primer recorrido

1. **Añadir proyecto** y elegir una carpeta.
2. La barra lateral contiene solo proyectos, en filas compactas, y puede plegarse desde el icono inferior, encima del icono de Ajustes. Crea tu primera cuenta en **Ajustes → Cuentas → Añadir cuenta** y selecciónala en la cabecera. Las conversaciones se abren en **pestañas**; el `+` o `⌘N` crea otra. El selector desplegable de la cabecera cambia de cuenta. Hay hasta **5 pestañas por proyecto y cuenta**: al abrir otra se retira de la barra la inactiva menos reciente, conservando historial y borrador. `⌘K` permite recuperarla. El `+` y la lupa se alinean a la izquierda; al plegar la columna se oculta la lupa. `⌘K` sigue abriendo el buscador. Al plegarla, cada proyecto se identifica por una forma geométrica y un color estables. La `×` cierra una pestaña; si tiene un agente abierto, exige confirmar su parada. Al reiniciar se abre únicamente la conversación seleccionada y el resto queda en la búsqueda. Cambiar de cuenta o proyecto conserva los procesos y los borradores, y recupera la última conversación visitada durante esta apertura de la app.
3. Escribe y envía: Claude y Codex arrancan automáticamente con el primer mensaje. Si falta autenticación, el borrador se conserva y se muestra el acceso oficial en Ajustes. No hay botones de abrir/detener en la cabecera; la `×` de una pestaña permite cerrar su proceso y `Esc` interrumpe el turno.
4. Abre **Ajustes → Cuentas** para añadir cuentas e iniciar o cerrar sesión, incluso sin proyectos. La primera instalación empieza sin cuentas; añadir un proyecto no crea ninguna. Los accesos del chat también llevan a Ajustes. Claude usa `claude auth login --claudeai` en una terminal integrada dentro de Ajustes; Codex abre el acceso oficial de ChatGPT en el navegador.

## Cuentas en Ajustes

**Añadir cuenta** permite elegir Claude o ChatGPT · Codex y un nombre opcional. Crea un perfil local independiente; después pulsa **Iniciar sesión** en su tarjeta para completar el flujo oficial. Las cuentas adicionales aparecen en el selector de todos los proyectos y se guardan al reiniciar. Los perfiles se crean solo al pulsar **Añadir cuenta**: `profiles/claude-1/`, `profiles/codex/` y, para cuentas posteriores, `profiles/claude-2/`, `profiles/codex-2/`, etc. Las cuentas existentes mantienen sus identificadores y directorios. Cada cuenta mantiene sus conversaciones, configuración, procesos y acceso independientes; cerrar sesión detiene únicamente los agentes de ese perfil. Se admiten hasta 100 perfiles.

El selector muestra **nombre del perfil · correo · plan** cuando la herramienta oficial confirma esos datos (`subscriptionType` en Claude y `planType` en Codex). Se comprueban al abrir la aplicación y pueden actualizarse en Ajustes. Si el proveedor no devuelve el plan, aparece «Plan no disponible»; no se deduce del modelo. La identidad se conserva solo en memoria y no se leen archivos de credenciales.

Cada perfil muestra su estado comprobado con la herramienta oficial y el correo cuando está disponible. Un error de consulta se presenta como **Estado sin verificar**, no como una desconexión. **Iniciar sesión**, **Cambiar cuenta**, **Cerrar sesión**, **Cancelar acceso** y actualizar estado están en una tarjeta por perfil. Cerrar Ajustes no cancela el acceso pendiente; puedes volver al panel.

Antes de cambiar la autenticación se confirma la parada de todas las sesiones abiertas con ese perfil, en todos sus proyectos. Las otras cuentas continúan funcionando. La operación se bloquea si hay un arranque pendiente o no se confirma la salida de un proceso. Los historiales, referencias y proyectos se conservan; después del acceso, envía el mensaje para que el agente arranque con la cuenta actualizada.

Claude ejecuta `auth status --json`, `auth login --claudeai` y `auth logout` con el `CLAUDE_CONFIG_DIR` del perfil. Codex usa `account/read`, `account/login/start`, `account/login/cancel` y `account/logout` mediante un app-server temporal con su `CODEX_HOME`. Estos procesos se ejecutan en la carpeta privada del perfil, sin necesitar un proyecto. La app no lee archivos de credenciales, no copia tokens y no guarda el estado de autenticación en `state.json`.

## El chat de Claude

Está construido sobre el **Agent SDK oficial** (`@anthropic-ai/claude-agent-sdk`), que lanza el mismo binario de Claude Code con el perfil aislado de cada cuenta. Una consulta de larga duración por sesión recibe los mensajes por streaming, de modo que la conversación tiene las mismas capacidades que la terminal:

- **Streaming** de texto, bloques de razonamiento (plegables) y llamadas a herramientas con sus entradas y resultados: comandos de Bash, diffs de Edit, contenido de Write, lecturas, búsquedas, subagentes (Task) anidados, listas de tareas (TodoWrite) en un panel fijo.
- **Permisos**: cada solicitud aparece como tarjeta con el detalle de la acción. **Permitir** una vez, **Permitir siempre** (reutiliza las reglas que sugiere Claude Code o permite la herramienta durante la sesión) o **Rechazar** con un motivo que Claude recibe. Las rutas fuera del proyecto y el motivo de la decisión se muestran.
- **Preguntas** (`AskUserQuestion`): opciones en forma de tiles, selección múltiple si procede y respuesta libre.
- **Modo plan**: al terminar el plan, puedes aprobarlo aceptando ediciones automáticamente, aprobarlo con permisos normales o pedir cambios.
- **Mensajes en cola**: puedes escribir mientras Claude trabaja; `Esc` interrumpe el turno.
- **Comandos** con `/`: menú con los comandos de Claude Code disponibles en el perfil (incluidos skills y plugins) y los del escritorio: `/clear`, `/config`, `/model`, `/permissions`, `/effort`, `/cost`, `/context`, `/status`, `/mcp`, `/rename`, `/terminal`, `/help`. Los demás se envían a Claude Code (`/compact`, `/init`, `/review`…).
- **Estado**: cuenta y suscripción, porcentaje de contexto usado, coste estimado, uso de la ventana de 5 horas, tareas en segundo plano, compactaciones, reintentos y avisos del sistema aparecen en la conversación o en el pie.
- **Historial**: la conversación se guarda localmente por sesión y Claude Code reanuda su propia sesión (`--resume`) al reabrir, de modo que recuerda el contexto.

### Configuración desde la interfaz

Los iconos del compositor cambian **modelo**, **modo de permisos** (`⇧⇥` alterna como en Claude Code) y **esfuerzo** en caliente. Se ha eliminado el panel lateral de configuración y sus accesos duplicados. `⌘,` y `/config` abren **Ajustes**, donde se gestionan las cuentas. Las opciones avanzadas guardadas previamente por sesión se conservan, aunque ya no hay un editor visual de ellas.

### Codex

`codex app-server` con `CODEX_HOME` propio, acceso con ChatGPT, aprobaciones por turno y preguntas. Codex también se configura desde la interfaz: chips de **modelo** (catálogo real y paginado de `model/list` del servidor), **política de aprobación** (preguntar, a petición, nunca) y **esfuerzo de razonamiento** (los niveles que admite cada modelo). Modelo, aprobación y esfuerzo se envían en cada turno; sandbox e instrucciones se aplican al reabrir el hilo.

Abre **Modelo de Codex** bajo el cuadro de escritura y selecciona el modelo. El esfuerzo ofrece solo niveles compatibles, también para el modelo predeterminado. **Actualizar modelos** vuelve a consultar el catálogo y muestra cualquier error en lugar de ocultarlo. La elección se guarda por sesión y se restaura al reiniciar. Volver a **Por defecto** envía el modelo y esfuerzo predeterminados comunicados por el servidor, para no heredar por accidente el modelo anterior del hilo. Consultar el catálogo no sustituye la autenticación: enviar tareas sigue requiriendo ChatGPT válido.

## Diseño

Interfaz plana y mínima: fondo liso, superficies del mismo tono, separadores finos y colores discretos. Se han retirado los encabezados decorativos y la leyenda bajo el compositor. Las pestañas, cuentas, estados y acciones conservan sus etiquetas accesibles; los proyectos usan formas geométricas de color para identificarlos también con la barra plegada. Sigue automáticamente el modo claro u oscuro del sistema (`prefers-color-scheme`), incluida la terminal integrada. No usa una librería de chat: la vista es React propio sobre el estado que emite el proceso principal, lo que permite dibujar herramientas anidadas, permisos, preguntas y notas del sistema exactamente como los produce cada agente.

## Perfiles y aislamiento

- Cada cuenta de Claude usa su propio `CLAUDE_CONFIG_DIR` bajo los datos de Agent Desk; Claude distingue sus credenciales del llavero por ese directorio.
- Se fuerza `forceLoginMethod: "claudeai"`. No se transmiten claves de API, tokens ni proveedores alternativos del entorno. Por defecto solo se carga la fuente de ajustes `user` del perfil aislado. Las opciones avanzadas guardadas previamente por sesión se conservan.
- Se permiten varias sesiones y cuentas activas en la misma carpeta. Cambiar de vista no detiene procesos; **⌘Q** cierra los agentes y las terminales antes de salir. La coordinación es cooperativa, no un aislamiento del sistema de archivos.

## Continuidad y almacenamiento

Datos en `~/Library/Application Support/Agent Desk` (ruta visible en Ajustes):

```text
state.json                 Proyectos, sesiones, configuración por sesión, estadísticas y conversaciones
profiles/claude-1/         Configuración, historial y sesiones de Claude 1
profiles/claude-2/         Ídem para Claude 2
profiles/codex/            Configuración e historial de Codex
```

Escritura atómica con permisos `0600`. No se guardan credenciales ni solicitudes de aprobación. El historial contiene texto y código de tus tareas; no se cifra adicionalmente.

## Atajos

`⌘K` buscar · `⌘N` nueva sesión · `⌘,` Ajustes · `↵` enviar · `⇧↵` nueva línea · `/` comandos · `⇧⇥` modo de permisos · `Esc` interrumpir o cerrar paneles.

## Arquitectura

- `electron/main.ts`: ventana, origen IPC, diálogos nativos.
- `electron/manager.ts`: proyectos, sesiones, procesos concurrentes, comandos locales y configuración en caliente.
- `electron/coordination.ts` y `electron/coordination-bridge.ts`: reservas atómicas de rutas y herramienta MCP compartida, con acceso local limitado por sesión.
- `electron/browser.ts`: pestañas nativas persistentes, almacenamiento aislado por proyecto y controles para los agentes. `src/browser-panel.tsx` coloca el navegador dentro del panel lateral.
- `electron/project-terminals.ts`: pseudoterminal de shell por proyecto.
- `electron/claude.ts`: ejecución del Agent SDK: cola de mensajes, `canUseTool`, interrupción, modelo/permisos/esfuerzo en vivo, uso de contexto, MCP.
- `electron/claude-events.ts`: reductor puro que convierte los mensajes del SDK (streaming, herramientas, resultados, sistema, límites) en el estado de la sesión.
- `electron/core.ts`: esquemas IPC y de configuración, traducción de la configuración a opciones del SDK, respuestas de permisos, aislamiento de entorno.
- `electron/rpc.ts`, `electron/codex-events.ts`: Codex app-server.
- `electron/store.ts`, `electron/processes.ts`, `electron/preload.ts`: persistencia validada, cierre de procesos y puente mínimo.
- `src/main.tsx` (aplicación), `src/chat.tsx` (mensajes, herramientas, permisos, preguntas, compositor, comandos), `src/accounts-settings.tsx` (cuentas), `src/markdown.tsx` (render seguro sin HTML), `src/terminal.tsx` (xterm), `src/style.css`.

Renderer con `contextIsolation`, sandbox y `nodeIntegration: false`; CSP estricta; validación con Zod de todas las acciones y de la configuración. El SDK se carga como módulo ES desde el proceso principal con un `import()` real.

## Verificación

```bash
npm test                    # lógica: IPC, aislamiento, permisos, reductor del SDK, RPC, procesos
npm run test:accounts       # Ajustes, login/cancelación, logout y paradas confirmadas; perfiles temporales
npm run test:runtime        # Con npm run dev abierto: actualización protegida y reinicio en perfil temporal
npm run test:models         # Selector con catálogo real, esfuerzo, actualización y persistencia; sin tareas de modelo
npm run test:integration    # Electron real: 3 proveedores concurrentes, MCP, pestañas, terminal, Git y navegador (perfiles vacíos)
AGENT_DESK_PROFILES_DIR="$HOME/Library/Application Support/Agent Desk" npm run test:chat
```

`test:chat` también captura el modo oscuro y los controles de Codex en el compositor. Usa los perfiles ya autenticados de esta máquina con un estado aislado y un proyecto temporal, y ejecuta tareas reales con Claude (modelo Haiku): lectura con herramienta, permiso de `Write` mostrado y aprobado con el archivo creado solo después, pregunta `AskUserQuestion` respondida desde las opciones, `/cost`, cambio de modo de permisos en caliente, interrupción de un turno largo y reanudación tras cerrar y abrir con memoria de la conversación. Las capturas quedan en `artifacts/1x-*.png` y el informe en `artifacts/chat-report.json`. `AGENT_DESK_PROFILES_DIR` apunta a la raíz de datos (no a la carpeta `profiles`).

Comprobado en esta máquina: Node 26.8.1, Electron 41.10.7, Claude Code 2.1.291, Agent SDK 0.3.291 y Codex 0.159.0-alpha.12.1.

`test:accounts` consulta los tres perfiles vacíos con los binarios oficiales, inicia y cancela OAuth de Codex (captura la URL sin abrir el navegador), inicia y cancela la PTY de autenticación de Claude, ejecuta los cierres de sesión oficiales sobre perfiles vacíos y comprueba confirmación, aislamiento, conservación de proyectos/historiales y restauración. Las capturas de Ajustes claro/oscuro se guardan en `artifacts/23-*` y `artifacts/24-*`. No envía prompts ni usa cuentas existentes.

**Pendiente de comprobación humana:** completar el acceso en Ajustes y cerrar sesión de una cuenta autenticada; interrupción y aprobación de una escritura real con Codex autenticado, y el flujo de `claude auth login` desde la terminal integrada con una cuenta nueva.

## Navegador integrado

El **globo junto a Git** abre el navegador Chromium integrado. Sus pestañas son independientes del chat seleccionado: puedes mantener varios proyectos y puertos abiertos, cambiar de proyecto y volver a la misma página. Admite webs HTTP(S), atrás, adelante, recarga y zoom por pestaña. Los enlaces HTTP(S) que abren ventanas nuevas aparecen como pestañas internas.

Ocultar el panel conserva las páginas. La `×` de una pestaña la cierra; la luna suspende su página y libera memoria sin detener el servidor. Al reanudar se vuelve a cargar la URL: el estado de formularios sin guardar puede perderse. Se admiten hasta 60 pestañas guardadas y seis páginas cargadas simultáneamente; al alcanzar ese límite, suspende una página para cargar otra. Las páginas ocultas limitan su actividad en segundo plano. Al reiniciar se restauran direcciones, títulos, proyectos y zoom como pestañas suspendidas, sin cargar todas las webs.

El almacenamiento web se comparte entre pestañas del mismo proyecto y es temporal, sin credenciales importadas ni restauración de sesiones web al salir. Cerrar un chat o quitar su proyecto no elimina las pestañas del navegador. Los servidores siguen el ciclo de vida del proceso que los inició; conservar una pestaña no mantiene vivo un servidor cuyo proceso se cierra.

Las URLs locales que aparecen en la salida de terminales y herramientas abren una pestaña cuando su puerto responde. Los indicadores comprueban cada 15 segundos los puertos locales conocidos; no exploran otros puertos ni garantizan que la aplicación responda correctamente.

Claude y Codex reciben la herramienta local MCP `agent_desk.browser`: listar y crear pestañas, navegar, inspeccionar texto y elementos, pulsar, rellenar campos, enviar teclas, desplazar, capturar, cambiar zoom y suspender. Cada agente puede actuar sobre las pestañas de su proyecto mediante `tabId`. Por ejemplo: **«Arranca el servidor, abre su URL en el navegador integrado y prueba el formulario»**. Las herramientas se conectan al arrancar cada agente; las sesiones anteriores necesitan cerrarse y reabrirse.

La web no recibe Node, preload ni acceso a IPC. Se bloquean direcciones de archivos locales, descargas y permisos de dispositivos. Los agentes operan sobre el documento principal mediante referencias de elementos obtenidas con `inspect`; no hay ejecución arbitraria de JavaScript, carga de archivos ni soporte específico para iframes/shadow DOM. Los campos de contraseña requieren intervención manual y sus valores no se incluyen en `inspect`. El texto visible y las capturas solicitadas se envían al proveedor del agente, igual que otras herramientas de su tarea. Las instrucciones del agente delimitan el uso a la tarea autorizada y tratan la web como contenido no confiable.

Verificación sin cuentas: `npm run build && node scripts/browser-check.mjs` comprueba navegación, controles DOM, capturas, aislamiento y dimensiones. `node scripts/browser-tabs-check.mjs` comprueba controles del compositor, pestañas entre proyectos, zoom nativo, suspensión, webs externas, ventanas emergentes, detección de URL desde terminal, estado de puertos y restauración tras reiniciar. Prueba optativa con suscripciones oficiales:

```bash
AGENT_DESK_PROFILES_DIR="$HOME/Library/Application Support/Agent Desk" node scripts/browser-live-check.mjs
```

Esta revisión se probó con Claude y Codex autenticados: ambos navegaron una web local de prueba, rellenaron un campo, pulsaron el botón y verificaron el resultado mediante texto y captura. Solo se usaron proyectos temporales. Las capturas de la interfaz y de la página nativa quedan separadas en `artifacts/33-*` y `artifacts/34-*`, porque la captura del renderer no incluye las vistas nativas superpuestas.

## Fuentes oficiales consultadas

- [Claude Agent SDK: opciones, permisos y mensajes](https://docs.claude.com/en/api/agent-sdk/overview) y los tipos instalados en `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [seguridad](https://www.electronjs.org/docs/latest/tutorial/security) y [webContents](https://www.electronjs.org/docs/latest/api/web-contents).
- [Codex app-server](https://developers.openai.com/codex/app-server/).
- [Claude: variables de entorno y CLAUDE_CONFIG_DIR](https://code.claude.com/docs/en/env-vars), [autenticación](https://code.claude.com/docs/en/authentication), [CLI](https://code.claude.com/docs/en/cli-reference), [ajustes](https://code.claude.com/docs/en/settings).

La barra de pestañas no crea procesos: el primer envío inicia el agente. El icono Terminal inicia el shell del proyecto. Solo se renderiza la terminal visible; al cambiar se recupera su buffer desde el proceso principal. Cerrar una pestaña con agente libera ese proceso, pero el historial de conversaciones sigue cargado en el estado local (todavía no se descarga del todo de memoria). No se eliminan conversaciones automáticamente.

Verificación de pestañas: `npm run build && node scripts/tabs-check.mjs`. Usa un proyecto y perfiles temporales, abre Codex sin autenticar y no envía tareas. Comprueba el límite, borradores, cambio de cuenta, confirmación y parada, recuperación y distribución compacta.

## Trabajo simultáneo y coordinación

Claude 1, Claude 2 y Codex pueden trabajar al mismo tiempo en una carpeta, con conversaciones y procesos independientes. Cada proceso recibe la herramienta MCP local `agent_desk.coordinate`, tanto en hilos nuevos como al reanudar. La app comparte las tareas actuales y las rutas reservadas, no el historial completo de las otras conversaciones. Los datos permanecen en memoria del proceso principal y se envían al proveedor correspondiente cuando el agente consulta la herramienta.

- `status`: consulta agentes, tareas y reservas del proyecto.
- `claim`: reserva atómicamente archivos o directorios. Dos agentes pueden reservar rutas distintas; si una ruta coincide o está dentro de un directorio reservado, se rechaza todo el lote. Se resuelven enlaces simbólicos y se rechazan rutas fuera del proyecto.
- `release`: libera las reservas propias. La app también las libera tras confirmar que el proceso ha terminado. No expiran mientras el agente sigue abierto.

Las instrucciones piden consultar tareas, reservar antes de escribir, volver a leer los archivos tras obtener la reserva y liberar después de terminar los comandos. Un hook de Claude añade una comprobación automática para Write/Edit/MultiEdit/NotebookEdit. El coordinador no modifica archivos del proyecto ni la configuración global. Solo las herramientas internas validadas `coordinate` y `browser` reciben aprobación automática; las aprobaciones de comandos, ediciones y otros MCP no cambian.

**Límite real:** las reservas no son bloqueos del sistema de archivos. Un comando de shell, herramienta externa, agente que ignore las instrucciones, terminal manual o alias por enlace duro puede saltárselas. No se garantiza ausencia total de conflictos ni se detecta semánticamente que dos tareas persiguen lo mismo. Los worktrees y un control obligatorio de todas las escrituras siguen pendientes. El indicador del chat permite consultar agentes y reservas reales.

## Panel derecho

La terminal se abre en un panel inferior que ocupa el ancho de chat y navegador. Terminal está arriba a la derecha, a la izquierda del navegador. Git tiene una barra compacta sobre el campo de mensaje con el nombre del proyecto, la rama y las líneas añadidas/eliminadas en cambios preparados y sin preparar (excluye archivos sin seguimiento y binarios). Pulsar el proyecto o los contadores abre/cierra los cambios actuales a la derecha. Se actualizan al cambiar de proyecto, cambiar el estado del agente, alternar la terminal, abrir el panel o volver a la ventana. Git y Navegador (globo) comparten el panel derecho. El separador entre chat y panel se puede arrastrar: el chat baja hasta 220 px y el panel ocupa el resto. La proporción se guarda localmente; un doble clic centra el reparto. Con el separador enfocado, las flechas ajustan el ancho y Inicio/Fin lo llevan a los extremos. El navegador nativo se adapta al tamaño y se oculta momentáneamente durante el arrastre para no interceptar el puntero. Con Git y navegador activos, el lateral se divide en zonas apiladas. Terminal es un shell real del proyecto; ocultarlo conserva el proceso y el buffer, y salir de la app lo cierra. Las sesiones antiguas de Claude en modo terminal oficial se muestran también abajo. La pantalla de chat vacía muestra una marca de agua, sin sugerencias.

## Verificación de esta revisión

- `npm test`: IPC, cuentas, permisos, persistencia, procesos, pestañas, reservas concurrentes, rechazo de rutas y autorización restringida del coordinador.
- `npm run build && node scripts/concurrency-check.mjs`: tres procesos oficiales a la vez, MCP conectado en Claude/Codex, llamadas reales a la herramienta, conflicto de reservas y recuperación de hilo vacío. No realiza llamadas de modelo ni toca proyectos existentes.
- `node scripts/workspace-check.mjs`: comprobación visual, shell y cwd reales, panel dividido y compacto, primer envío de Codex sin autenticar conservando el borrador.
- `AGENT_DESK_PROFILES_DIR="$HOME/Library/Application Support/Agent Desk" node scripts/coordination-live-check.mjs`: **comprobada en esta revisión**, prueba optativa con las suscripciones autenticadas. Envía tareas mínimas simultáneas de Claude/Codex en una carpeta temporal para comprobar herramientas, rechazo de una reserva y reanudación de un hilo persistido; no crea ni edita archivos en esa carpeta.

Esta revisión cambia el protocolo interno a v11. En una instancia de desarrollo anterior, cierra las pestañas con procesos abiertos y pulsa **Actualizar aplicación**, o sal con `⌘Q` y ejecuta `npm run dev`. No se reinician agentes activos automáticamente.

Revisión visual minimalista: `npm run build && node scripts/browser-check.mjs` verifica arrastre, teclado, ancho mínimo, persistencia de la proporción, iconos estables, ausencia de leyendas y adaptación a 900 px, con una web local real. Capturas en `artifacts/36-*` y `artifacts/37-*`.

Revisión de cuentas ampliables: `node scripts/profiles-check.mjs` (tras `npm run build`) crea cuentas adicionales desde Ajustes, consulta los binarios oficiales con perfiles vacíos, abre un proceso Claude y otro Codex en esos perfiles, verifica cierre de sesión limitado al perfil, persistencia y rechazo de identificadores no registrados. También comprueba los controles solo con iconos (la selección actual aparece al pasar el ratón) y las barras de navegador/pestañas alineadas a 38 px. No envía tareas de modelo. Capturas en `artifacts/38-*` y `artifacts/39-*`.

Renombrado directo: doble clic sobre un proyecto o una pestaña de chat permite editar su nombre en el mismo sitio. Enter o salir del campo guarda; Esc cancela y un nombre vacío conserva el anterior. El nombre de proyecto es una etiqueta local: no renombra la carpeta ni altera su ruta o archivos. Doble clic en un proyecto plegado expande la barra para editarlo. `node scripts/navigation-check.mjs` verifica edición, cancelación, persistencia, ruta intacta, buscador y terminal inferior con su PTY real.

## Uso de suscripción y adjuntos

El selector centrado ocupa una sola línea de 26 px: nombre de la cuenta (sin correo ni plan), **5h · porcentaje consumido**, **7d · porcentaje semanal consumido** y una cuenta atrás. Dos líneas de 2 px muestran las cuotas por separado. La cuenta atrás corresponde al límite de 5 horas en Claude y al semanal en Codex; el tooltip identifica la renovación. No suma ventanas ni estima consumo a partir de tokens, coste o contexto. Codex usa `account/rateLimits/read` y sus notificaciones oficiales; prioriza el bucket `codex`. Claude usa las ventanas generales de la consulta estructurada `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` del SDK instalado, únicamente cuando ya hay un chat de esa cuenta abierto. Esta función de Claude es experimental: versiones que no la incluyan muestran una explicación. No se leen ni extraen credenciales. Las ventanas específicas de un modelo y el uso extra de pago no se mezclan con las cuotas generales.

Se consulta al seleccionar cuenta, al cambiar el estado del agente, al volver a la ventana y cada minuto mientras sea visible. La cuenta atrás se actualiza cada 10 segundos. Cada porcentaje deja de mostrarse tras su propio reinicio, o con lecturas de más de 3 minutos, hasta recibir datos nuevos. Ausencia de datos muestra «—», nunca 0% inventado. No se consultan saldos mediante llamadas de inferencia.

El **+** del compositor abre un diálogo nativo para hasta 4 imágenes por mensaje, de hasta 5 MB cada una (PNG, JPEG, GIF y WebP). Se validan tipo real y decodificación en el proceso principal, se muestran miniaturas y se pueden quitar antes de enviar. Se admite enviar solo imágenes. Los borradores de adjuntos se conservan por chat mientras la app está abierta, también si el envío falla por falta de autenticación. Las referencias IPC son identificadores opacos ligados a la sesión, sin acceso del renderer a rutas arbitrarias. Los originales se copian a `attachments/` dentro de los datos privados de Agent Desk; no se modifican los archivos elegidos ni los proyectos. Los adjuntos no enviados se limpian al salir; los enviados se conservan para que Codex pueda reanudar referencias locales. Las miniaturas de mensajes enviados se guardan con la conversación.

El envío usa bloques de imagen base64 del flujo oficial de Claude y `localImage` de Codex app-server. No cambia el método de autenticación ni añade un proveedor de API. Referencias: [Codex app-server](https://learn.chatgpt.com/docs/app-server) y [entrada de imágenes en Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). La consulta experimental de uso se ha validado contra los tipos del SDK local instalado.

Verificación: `npm test` cubre unidades de cuota, reinicios/caducidad, selección de ventanas, aislamiento de adjuntos y formatos de envío. `node scripts/usage-images-check.mjs` usa Electron, diálogos y procesos oficiales reales con perfiles vacíos; comprueba miniaturas, eliminación, cambio de chat, consulta de uso sin autenticación y conservación del adjunto tras rechazo de Codex sin sesión. La recepción e interpretación de la imagen por un modelo y los porcentajes de una cuenta autenticada necesitan una comprobación con sesión iniciada. No se han simulado respuestas ni cuotas dentro de la aplicación.


## Ahorro de tokens por cuenta

En **Ajustes → Cuentas**, cada perfil guarda un nivel independiente: Desactivado, Suave (respuesta breve), Equilibrado (menos repetición y esfuerzo hasta medio) e Intenso (una frase o 1–3 viñetas, unas 60 palabras como máximo orientativo, y esfuerzo bajo en peticiones sencillas). Las peticiones detectadas como complejas, planes, imágenes y continuaciones conservan el esfuerzo. Se respetan los niveles que declara el catálogo y cualquier esfuerzo manual ya inferior. Estas instrucciones son preferencias, sin truncar respuestas ni omitir verificaciones o permisos.

**Modelo automático** es independiente del nivel. Una heurística local, sin otra llamada de inferencia, reconoce peticiones sencillas, generales y complejas y elige una familia del catálogo disponible. Una continuación breve conserva el modelo anterior; los modelos desconocidos o la falta de alternativas conservan el manual. La clasificación no entiende todo el proyecto ni garantiza acertar. El modelo manual permanece guardado; se recupera al desactivar Auto. El selector de modelo del compositor incluye Auto; elegir un modelo manual desactiva Auto. El icono de hoja permite cambiar el ahorro de la cuenta. Ambos controles están en la fila inferior del compositor, sin anotaciones; sus tooltips muestran la selección actual.

Claude recibe la preferencia mediante `UserPromptSubmit.additionalContext` y cambia modelo/esfuerzo con los controles del SDK antes del envío, cuando está listo. Las peticiones en cola conservan los controles del proceso en curso. Codex recibe la política junto a las instrucciones del hilo (se reanuda al cambiar el nivel) y modelo/esfuerzo mediante `turn/start`. No modifica permisos, autenticación ni el terminal oficial. No instala skills ni modifica instrucciones de los proyectos. Cambiar de modelo puede afectar a la caché; las cuotas de suscripción no equivalen directamente a tokens ahorrados y no se promete un porcentaje de reducción.

Verificación: `npm test` incluye persistencia, validación IPC, clasificación y llamadas de Manager con transportes de prueba para ambos proveedores, restauración manual, cola Claude y permisos Codex. `node scripts/optimization-check.mjs` comprueba los controles reales en Electron, cambios seguidos, aislamiento por cuenta, reinicio y desactivación con perfiles temporales. Estas pruebas no consumen inferencia ni miden ahorro real. Capacidades contrastadas con [Codex app-server](https://learn.chatgpt.com/docs/app-server) y los tipos de Claude Agent SDK instalados.

## Chat compacto

El historial agrupa las intervenciones del asistente y sus herramientas entre mensajes del usuario o avisos del sistema. La respuesta queda visible sin cabeceras repetidas; el texto previo, las herramientas y el razonamiento se conservan bajo **Ver pasos**. Durante una tarea, una línea fija sobre el compositor muestra la actividad más reciente y permite desplegar su registro. Al terminar se muestra la respuesta; al abrir o parar un proceso se mantiene el historial anterior. Las solicitudes de permiso y los avisos de error siguen visibles. La agrupación es una proyección de la interfaz: no borra mensajes ni recorta el contexto que recibe el modelo, y por sí sola no ahorra tokens.

`tests/conversation.test.ts` cubre agrupación, preservación de mensajes, permisos, errores, arranques y paradas. `node scripts/compact-chat-check.mjs` (tras compilar) comprueba la posición fija, una sola línea, desplegables, respuesta y permisos en un navegador aislado con datos de prueba, sin llamadas a modelos. Capturas en `artifacts/chat-compacto-*.png`.

Los selectores del chat muestran solo las opciones, sin descripciones. El selector de permisos ofrece el modo sin aprobaciones de Claude y **Acceso total** de Codex. Activarlos puede requerir reabrir el proceso para aplicar sus opciones de arranque; no se activan automáticamente al cambiar el ahorro.

## Firma del compositor

Debajo del campo de escritura aparece el modelo y `↑entrada ↓salida`, sin marco. Auto muestra el modelo elegido al enviar y vuelve a Auto al preparar otro mensaje. Durante una tarea conserva el modelo de esa tarea aunque cambie la selección manual para la siguiente. El tooltip muestra los tokens exactos acumulados de la conversación; `—` significa que aún no hay lectura confirmada. No son una estimación de cuota ni del texto del borrador.

Claude actualiza los totales con el resultado de cada respuesta, incluyendo entrada de caché. Codex consume `thread/tokenUsage/updated` y reemplaza los totales acumulados del hilo: no suma otra vez caché o razonamiento ni duplica notificaciones repetidas. Los datos confirmados se guardan con la sesión. Protocolo contrastado con los tipos generados por el binario instalado y la [documentación oficial de eventos](https://learn.chatgpt.com/docs/app-server#events). La firma no genera llamadas de inferencia ni sondeos adicionales.

## Ajustes de interfaz

**Ajustes → Interfaz** permite elegir el tamaño de los iconos de proyectos (14–28 px), la letra del chat (8–20 px), su color, el color del resto de iconos y el de los textos de la interfaz. El tamaño del icono ajusta también su botón y el ancho de la barra de proyectos plegada. **Auto** adapta el color al tema; **Restablecer** recupera los valores iniciales. La vista previa y el chat cambian al momento. Las preferencias se guardan localmente en esta instalación y se restauran al abrirla; no afectan a las páginas del navegador integrado.
