# Revisión de calidad · 22 de octubre de 2026

## Distribución 0.1.8 · 30 de octubre de 2026

Se integran en `main` las mejoras de interfaz, conexiones CLI/API, navegador, Chrome y aplicaciones de usuario. La rama remota `codex/app-quality-review` ya era ancestro de `main`; no quedaban commits de esa rama pendientes de fusionar. La versión de `package.json` y del lockfile pasa a **0.1.8**.

La batería de publicación vuelve a pasar: **417 pruebas, 416 correctas, una omitida y cero fallidas**. El empaquetado comprueba dependencias, TypeScript, compilación, firma local y apertura real de la app desde una carpeta ajena al repositorio con datos temporales. Se verifican interfaz, terminal, Node incluido, Claude Code, Gemini CLI, OpenCode, SDK y carga de `playwright-core` con sus capacidades de conexión y perfil persistente. No se usan cuentas reales ni se descarga otro navegador.

El instalador se genera para **macOS Apple Silicon (arm64)** con firma ad hoc, sin Developer ID ni notarización. Las instrucciones del DMG y del README incluyen instalación por usuario en `~/Applications`; el acceso Applications del disco conserva su destino estándar `/Applications`. Los artefactos de `release/` siguen excluidos de los commits. Continúa el aviso no bloqueante de Vite sobre el tamaño del chunk principal.

## Aplicaciones de usuario y Chrome · 29 de octubre de 2026

IPC 51 incorpora Chrome como segundo backend del navegador. El modo gestionado usa el ejecutable instalado, una tubería privada y un perfil persistente por proyecto. El personal descubre `DevToolsActivePort` según el flujo oficial de Chrome 144+, conserva las preferencias nativas mediante `noDefaults` y requiere que el usuario habilite y autorice la conexión en Chrome. Las conexiones guardadas se restauran desconectadas. El enrutado comparte herramientas con los proveedores, exige el `tabId` para Chrome y rechaza pestañas de otros proyectos o desconectadas.

Incluye cursor visible, clics nativos, formularios, archivos del proyecto, capturas con dimensiones reales, diálogos y descargas. El cierre respeta `beforeunload`; una respuesta manual en Chrome limpia el diálogo pendiente del editor. Las descargas tienen eventos de progreso y cancelación; Chrome personal conserva destino y opción de preguntar. Solo se ofrece Finder cuando se ha verificado la ruta suministrada por Chrome. Los archivos gestionados reciben nombres seguros y carpetas únicas. Desconectar una sesión personal mantiene sus pestañas y proceso; apagar espera los lanzamientos pendientes y cierra las instancias propias.

La revisión detectó que `Emulation.setPageScaleFactor` simula zoom táctil y podía desplazar los clics. Se retiró ese control para Chrome, se verifica la geometría en DPR 1 y 2 y se rechaza la interacción por coordenadas con zoom táctil activo. Zoom y pausa/reanudación de descargas externas permanecen en los controles nativos de Chrome. El selector manual de elementos continúa en el navegador integrado.

**Ajustes → Aplicaciones** muestra inventario de aplicaciones y CLI, búsqueda, capacidades, apertura y Finder. El instalador recibe exclusivamente una `.app` elegida mediante diálogo nativo y la publica en `~/Applications`, sin reemplazar otra aplicación. Verifica estructura y enlaces, prepara una copia temporal y conserva atributos, cuarentena y permisos con `ditto`. No ejecuta automáticamente el resultado ni instala `.pkg`. Las pruebas de instalación usan una carpeta de usuario temporal.

Validación final: compilación completa correcta; **417 pruebas, 416 correctas, una omitida y cero fallidas**. Pasan `browser-chrome-check.mjs`, `chrome-geometry-check.mjs`, `chrome-ui-check.mjs`, `applications-ui-check.mjs` y `applications-chrome-check.mjs`, además de las regresiones `browser-workflows-check.mjs` y `browser-ux-check.mjs`. El acceso a Chrome quedó dentro de la barra existente para conservar el límite original de 110 px de cabecera compacta. Se comprobó además que `playwright-core` se carga desde una copia independiente del paquete de distribución; no se descarga otro navegador. Capturas de las interfaces revisadas en `artifacts/chrome-main-panel.png` y `artifacts/applications-settings.png`, además de las variantes compactas. Continúa el aviso previo de Vite por el tamaño del chunk principal.

El flujo personal se verificó contra otra instancia temporal de Chrome, incluida la conservación del navegador al desconectar. No se conectó el perfil habitual del usuario ni se aceptó su aviso real de autorización. Para activar estas capacidades es necesario reiniciar la app y reabrir los agentes anteriores.

## Formularios, descargas y diálogos · 29 de octubre de 2026

Ampliación posterior centrada en navegación cotidiana (IPC 50): casillas de condiciones idempotentes, arrastre HTML5/puntero, selección de archivos del proyecto y envío real de formularios, descargas autenticadas y exportaciones Blob. La app muestra progreso, pausa, reanudación, cancelación y acceso a Finder; los registros de esta sesión siguen disponibles al cerrar pestañas. Las descargas usan rutas únicas en la carpeta del usuario y no se ejecutan automáticamente. Los permisos de las webs dejan de denegarse todos: los rutinarios funcionan y los sensibles se presentan con su origen y una decisión explícita en la interfaz.

Los diálogos `alert` y `confirm` se contestan en la app mediante un adaptador por WebContents del manejador de Electron 45.1.0. Un preload aislado restaura únicamente `prompt(message, default)` mediante un canal fijo validado por WebContents/frame; conserva la respuesta síncrona de texto o null. No expone Node, IPC general ni comandos. El adaptador nativo conserva el comportamiento original si no reconoce la implementación de una versión futura; el puente de prompt sigue funcionando. La cola retiene la operación real mientras el llamante puede recibir el diálogo pendiente, evitando solapar entradas de ratón después de responder. La protección nativa `beforeunload` no se acepta automáticamente ni se repiten formularios POST para simular su aceptación.

Validación final:

- `npm run build` correcto; continúa el aviso de tamaño de chunk de Vite.
- Batería completa: **405 pruebas, 404 correctas, una omitida y cero fallidas**.
- `browser-workflows-check.mjs`: app completa, checkbox de condiciones, cookies de sesión, descarga guardada, exportación Blob, bloqueo de permiso de notificaciones, confirmación, prompt/alert desde la interfaz, subida de archivo y multipart recibido por el servidor, descargas visibles tras cerrar la pestaña.
- `browser-download-check.mjs`: cookies, nombres repetidos sin sobrescritura, Blob, progreso y pausa/reanudación/cancelación.
- `browser-interactions-check.mjs`: casillas/interruptores, archivo oculto, shadow DOM y marcos, limpieza de selección, multipart, arrastre HTML5 y deslizador con entrada de confianza.
- `browser-dialogs-check.mjs`: botones reales de la ventana principal, aceptar/cancelar, texto por defecto/vacío, avisos y ausencia de diálogos bloqueantes del sistema.
- `browser-ux-check.mjs` y `browser-control-check.mjs`: regresiones anteriores del selector, geometría, cursor, teclado, zoom y control en segundo plano correctas.

Las pruebas usan perfiles, archivos y servidores locales temporales; no se han usado cuentas ni plataformas de producción. Se inspeccionó `artifacts/browser-downloads-panel.png`. Para acceder a estas capacidades hay que reiniciar la app y reabrir los agentes anteriores. El límite de seis páginas activas y la selección manual para archivos externos/credenciales permanecen; no se descartan páginas con formularios sin guardar automáticamente.

## Control del navegador y conexiones · 29 de octubre de 2026

Esta revisión posterior corrige fallos de transporte CLI/API y amplía el control del navegador. El puente MCP reconoce como válidas las respuestas de listar/crear pestañas; OpenRouter y los modelos locales con herramientas reciben el navegador. El transporte API incorpora plazo de inactividad, control de flujo y errores de red útiles; los comandos reciben el proxy/CA configurado y la detección de CLI cubre instalaciones de usuario. Las tuberías RPC rotas dejan de mantener peticiones pendientes hasta su timeout.

El navegador utiliza entrada nativa de Chromium con cursor y resaltado visibles, también en pestañas ocultas. Incluye hover, coordenadas, opciones de select, modificadores de teclado y scroll de contenedores. La inspección recorre shadow DOM abierto y marcos del mismo origen; las referencias caducadas conservan errores útiles. La navegación espera al DOM con un plazo máximo. El selector manual prepara texto, selector orientativo y captura en el borrador sin activar el control web ni enviar el chat; funciona sobre marcos externos y diálogos modales.

Validación de esta revisión:

- `npm run build`: correcto. Continúa el aviso no bloqueante de tamaño del chunk principal.
- `node --import tsx --test --test-timeout=60000 tests/*.test.ts tests/*.test.mjs`: 382 pruebas, 381 correctas, una omitida, cero fallidas.
- `node scripts/browser-control-check.mjs`: entrada de confianza en pestañas ocultas, cursor, hover, marcos, shadow DOM, edición, selección nativa, scroll, atajos, referencias caducadas, protección de contraseñas y coordenadas con zoom.
- `node scripts/browser-ux-check.mjs`: geometría nativa, selector real, cancelación con Escape, selección sin activar controles (incluidos marcos externos y modales), borradores sin envíos, navegación y vista compacta.
- `node scripts/provider-proxy-check.mjs`: transporte Electron con proxy local, autenticación acotada, aislamiento de cookies y cancelación de streaming.

Se inspeccionaron las capturas nativas `artifacts/browser-agent-cursor.png` y `artifacts/browser-element-picker-page.png`. Se usan servidores locales, datos temporales y proveedores simulados; no se han probado cuentas reales ni el acceso a todas las plataformas. Las limitaciones de la batería histórica de interfaz descritas abajo siguen vigentes. Requiere reiniciar Agent Desk y reabrir los agentes anteriores para cargar el IPC 49 y las herramientas nuevas. No requiere permisos de administrador ni Accesibilidad.

## Cierre del 29 de octubre de 2026

Esta sección actualiza los resultados históricos del resto del documento. Se recuperó la comparación que quedó pendiente al interrumpirse el chat, con base `7f41218`, y se revisaron los cambios sin descartar el trabajo existente.

La pasada incluye contraste y foco de teclado, alineación de barras, rutas y pestañas largas, scroll de proyectos, navegación por menús, atajo de ventana flotante en macOS, separación del filtro de Archivos y Cambios, confirmación al perder CSS y eliminación de sondeos y renders innecesarios. Se conservan los cambios de actualización de dependencias enumerados en el README.

Verificación repetida al cerrar:

- `npm run build`: correcto, incluida la comprobación de TypeScript y el proceso principal. Vite avisa de un chunk principal de 510,82 kB; no es un error de compilación.
- `npm test`: 364 pruebas, 363 correctas, 1 omitida y 0 fallidas.
- `npm audit`: 0 vulnerabilidades conocidas en el árbol instalado.
- Electron 45.1.0 ejecuta una PTY real con `node-pty`: salida `terminal-ok` y código de salida 0.
- Los 15 recorridos siguientes pasan de nuevo. Se inspeccionó además la captura del espacio de trabajo oscuro con nombres largos y ventana reducida.

```bash
node scripts/ui-regression.mjs design-audit product-controls details-motion workspace-panel streaming-performance chat-interactions attention settings-polish floating-appearance browser-ux attachments team interface optimization remove-account
```

La batería completa conservada de la sesión anterior contiene **23 recorridos correctos y 25 fallidos**. La ejecución de comparación en HEAD anterior contiene **22 correctos y 26 fallidos**. No hay recorridos que pasaran en la base y fallen con estos cambios; `browser-ux` pasa con los cambios. Esta comparación no demuestra que los fallos heredados sean inocuos ni valida los pasos posteriores al punto donde se detiene cada prueba.

Los recorridos que fallan en ambas versiones son: `onboarding`, `state-sync`, `ui-polish`, `multichat`, `floating-chat`, `compact-chat`, `chat-design`, `navigation`, `workspace`, `tabs`, `browser`, `browser-tabs`, `usage-images`, `response-actions`, `worktree-ui`, `git-images`, `prechat-project`, `accounts`, `account-navigation`, `profiles`, `providers`, `css-editor`, `theme`, `antigravity` y `freebuff`. Varios buscan botones retirados o textos antiguos (por ejemplo, «Navegador», «Ocultar herramientas» o «Mover terminal a la derecha»); otros fallan por expectativas de fixtures, colores o autenticación. Queda pendiente actualizar e investigar esos recorridos: no se han modificado sus expectativas para ocultar los fallos.

Los resultados comparados y logs de cierre se conservan en `artifacts/review-2026-10-29/`; las capturas y logs de los recorridos repetidos, en `artifacts/design-audit/` y `artifacts/v20/`. Son archivos locales ignorados por Git. No se han repetido conversaciones de pago ni accesos con cuentas reales. La revisión queda cerrada con estas limitaciones explícitas; no se afirma que toda la batería esté verde.

Base de trabajo: `fd8040d` en `main`. Rama: `codex/app-quality-review`.

## Integración con el otro ordenador

Los cambios de ese ordenador podrían seguir sin subir. Esta rama no presupone que estén incluidos: conserva el protocolo IPC 42, los formatos guardados y las dependencias del proyecto. Las modificaciones se agrupan en commits para facilitar su revisión y combinación.

Antes de integrar, guarda el trabajo del otro ordenador en su propia rama con commits y conserva cualquier archivo local que Git ignore. Después trae ambas ramas al mismo repositorio. Crea una rama de integración desde el desarrollo más reciente y combina `codex/app-quality-review` mediante un merge normal; resuelve cada conflicto conservando las funcionalidades de ambos lados. Evita reemplazar carpetas completas por esta copia.

La rama de entrega es [`codex/app-quality-review`](https://github.com/amariner/mini-editor/tree/codex/app-quality-review). Se publica por separado de `main` para poder combinar el trabajo del otro ordenador. Al preparar la entrega, `origin/main` seguía en `fd8040d`; no había nuevas ramas remotas. Desde el otro ordenador puedes traerla con `git fetch origin` y revisar `origin/codex/app-quality-review` antes de integrarla.

El archivo `artifacts/agent-desk-quality.bundle` ofrece además una copia de los commits para trasladarlos sin copiar carpetas de desarrollo ni datos privados. El repositorio de destino debe contener la base `fd8040d` (si falta, actualiza sus referencias desde GitHub). Desde ese repositorio puedes importar la rama con:

```bash
git fetch /ruta/agent-desk-quality.bundle codex/app-quality-review:codex/app-quality-review
```

Después combina esa rama desde la rama de integración que hayas preparado. Si el nombre ya existe, importa con otro nombre y compara antes de fusionar.

Puntos que conviene revisar si también se han editado allí:

- `src/main.tsx`: sincronización del estado, buscador y callbacks funcionales del compositor.
- `src/chat.tsx`, `src/multichat.tsx` y `src/chat-drafts.ts`: confirmación de envíos y conservación de borradores.
- `src/floating-chat-protocol.ts`: mantiene sus exports; los valores sin validadores están ahora en `floating-chat-state.ts`.
- `src/style.css`, `src/shell-polish.css` y `src/motion.css`: ajustes puntuales de contraste, foco y buscador.
- `electron/store.ts`, `electron/attachments.ts` y `electron/rpc.ts`: guardado, adjuntos y cierre de procesos.
- `src/team.tsx`, `src/git-bar.tsx` y los nuevos componentes de navegación: las conversaciones pasan del antiguo tabulador superior al panel de proyectos. Git queda en un control inferior del compositor. Los gestos de ventana flotante reutilizan la acción IPC existente.

## Cambios comprobados

- Los envíos fallidos conservan texto y adjuntos. Una confirmación tardía solo retira lo enviado y respeta un borrador posterior. Fallar al refrescar la vista después de un envío aceptado no invita a reenviarlo.
- El estado recibido en directo prevalece frente a lecturas antiguas. Las operaciones concurrentes conservan su indicador de actividad hasta terminar. El arranque fallido permite reintentar.
- Si el almacenamiento local falla, los borradores siguen disponibles en memoria y se sincronizan con otras ventanas abiertas. Un aviso recuerda copiar el texto antes de cerrar: este modo de recuperación no garantiza persistencia tras salir de la app.
- El multichat acepta archivos pegados o arrastrados y conserva la posición al cargar historial anterior. La composición de texto con IME no dispara envíos ni atajos.
- El terminal recupera la salida en directo aunque falle su historial, libera suscripciones y evita redimensionados repetidos.
- El guardado tiene un plazo máximo de dos segundos durante streaming continuo. Los documentos adjuntos se copian y verifican sin cargar el lote completo en memoria. Los cierres RPC concurrentes comparten la misma operación y limpian sus temporizadores.
- El buscador limita a 60 resultados, mantiene visible el campo en ventanas bajas y evita repetir búsquedas en renders ajenos a la consulta. El foco de teclado y el contraste de navegación/comentarios mejoran en claro, oscuro y alto contraste.
- Markdown admite enlaces a rutas con espacios, limita la anidación extrema y reutiliza el resaltado del código.
- El renderer deja de cargar Zod por importar constantes de las ventanas flotantes. La validación IPC continúa en el proceso principal; no se añaden dependencias.
- El sondeo de cuota conserva su actualización periódica y al enfocar la ventana, sin repetirse en cada transición de actividad del agente.

La compilación de producción del JavaScript principal baja de 543,06 a 456,10 kB al separar los validadores (aproximadamente un 16 %; gzip: 170,46 → 145,94 kB). Son tamaños de bundle, no una medición de memoria total de Electron.

## Verificación después de integrar

Resultado de la revisión inicial: **269/269 pruebas**, compilación de producción correcta y **20 recorridos de interfaz correctos**. El último recorrido de chat se repitió tras ajustar la espera de la búsqueda diferida; el registro consolidado conserva la referencia de cada ejecución en `artifacts/quality-review-results.json`.

```bash
npm test
npm run build
node scripts/ui-regression.mjs onboarding design-audit state-sync chat-interactions ui-polish attention settings-polish multichat floating-chat compact-chat chat-design navigation workspace tabs browser-ux browser-tabs attachments response-actions interface theme
```

Estas comprobaciones usan datos temporales, proveedores simulados y servidores locales. Los logs de interfaz están en `artifacts/v20/`; las capturas de contraste y ventanas pequeñas, en `artifacts/design-audit/`. No constituyen una prueba de los cambios que aún estén únicamente en el otro ordenador ni una validación de todos los proveedores con cuentas reales.

## Navegación simplificada a partir de las capturas

- Añadir proyecto aparece al pasar por el panel o enfocarlo con teclado y comparte el eje de los iconos. Buscar solo aparece cuando la lista requiere scroll; ⌘K sigue disponible.
- Doble clic en una zona libre del panel pliega o expande la barra; los bloques de proyecto quedan excluidos de ese gesto. ⌘B ofrece el mismo control por teclado. Doble clic en el nombre del proyecto o F2 permiten renombrarlo sin cambiar el estado del acordeón. En el panel plegado el icono queda libre para seleccionar; ⌘N crea un chat.
- Un clic en el nombre o icono del proyecto pliega o despliega únicamente su lista de chats con una transición de acordeón. Cada proyecto conserva su estado al recargar. Los chats ocultos quedan fuera del foco y de la navegación asistida, manteniendo su selección, borrador y orden. Enter y Espacio ofrecen el mismo control; crear un chat nuevo vuelve a desplegar su proyecto.
- Crear conversaciones aparece como una línea divisoria con «+» centrado entre el proyecto y su chat más reciente, al pasar por el bloque o enfocarlo con teclado. Su espacio permanece estable para no desplazar los chats. Los estados de proyecto, chats y subchats comparten una columna; al pasar por cada fila, la X sustituye al estado en su misma posición y conserva la confirmación antes de borrar.
- Se retiran las pestañas superiores y la cabecera de proyecto/chat del compositor. La navegación queda en el panel lateral; F2 o clic derecho sobre un chat permiten renombrarlo. El aislamiento se configura dentro del panel de Git/worktree inferior.
- Crear o eliminar conversaciones no borra el estado de Git del mismo repositorio ni deja la barra en «Consultando…» hasta el siguiente sondeo.
- Los chats de la misma carpeta comparten el estado de las operaciones Git y su borrador de commit. El control de Git se muestra en el pie del compositor conservando ese estado al cambiar de conversación.
- Arrastrar un chat fuera del panel lateral o de la cuadrícula muestra una tarjeta elevada y permite abrir una ventana flotante al soltar. Escape o perder el foco cancelan el gesto; Alt+Mayús+F ofrece acceso por teclado. Dentro del panel se ordenan chats hermanos y la cuadrícula conserva su ordenación interna.

Verificación de esta iteración: **269/269 pruebas de lógica** y **28 comprobaciones nuevas de navegación**, en claro y oscuro y con anchos de 1280, 760 y 480 píxeles. Incluyen geometría, hover, foco, borradores, creación/eliminación, worktree, desbordamiento y cancelación del arrastre. Registro y capturas: `artifacts/project-navigation/`.

```bash
SOURCE_BUILD=1 node scripts/project-navigation-check.mjs
```

La comprobación compila el renderer en una carpeta temporal para no interferir con la aplicación de desarrollo abierta.

También pasan los recorridos de multichat, estilo/foco en claro y oscuro, navegación nativa, ventanas flotantes nativas y ciclo de vida de chats (`tabs-check.mjs`, adaptado a la navegación lateral y el control inferior de Git). Este último comprueba foco por teclado, renombrado, borradores, procesos activos, terminal y eliminación confirmada. Para los recorridos de Electron mientras `npm run dev` está abierto, usa `SOURCE_DEV_URL=http://127.0.0.1:5173`; sus perfiles y datos siguen siendo temporales. La aplicación valida ese origen, por lo que un servidor de preview en un puerto aleatorio no sirve para esas pruebas nativas.

## Refinamiento del panel de chats

- El estado del proyecto queda alineado con el de todos sus chats, incluidos los anidados. La X ocupa exactamente ese lugar al pasar por la fila. El divisor con «+» mantiene libre el nombre e icono del proyecto para seleccionar, plegar su acordeón y renombrar con doble clic.
- Los chats nuevos aparecen primero dentro de su grupo. Se pueden seleccionar y ordenar verticalmente con arrastre o Alt+↑/↓; los hijos acompañan al padre y no cambian de relación. Al arrastrar cerca de los bordes, la lista se desplaza automáticamente.
- El orden manual se conserva al recargar. Se guarda por grupo en el almacenamiento local de esta instalación, sin modificar el protocolo IPC ni el formato de los proyectos. Los chats creados después se anteponen al orden guardado.
- Durante la ejecución se animan las cuatro formas de Agent Desk mediante CSS, sin temporizadores de JavaScript. Se respeta la preferencia de movimiento reducido. Al completar, aparece una marca verde suave y una ligera coloración de la fila, más visible mientras queda pendiente de leer; se mantienen las notificaciones existentes.
- La barra lateral pasa a 216 px en escritorio y 184 px en ventanas estrechas; las filas de chat tienen 26 px de alto mínimo. Los iconos y controles permanecen en posiciones estables al aparecer y desaparecer.
- Los iconos de estado usan contornos finos, tamaños contenidos y colores atenuados. Los iconos de identidad del proyecto conservan sus formas rellenas originales. El verde de finalización y los fondos se suavizan; las conversaciones pendientes de leer conservan mayor énfasis. El divisor de creación funciona también con Enter o Espacio y desaparece al plegar el panel.

Comprobaciones específicas y capturas en `artifacts/sidebar-refinement/`. Para repetirlas con datos temporales:

```bash
SOURCE_BUILD=1 node scripts/sidebar-refinement-check.mjs
```

Resultado final de este refinamiento: **275/275 pruebas de lógica**, TypeScript y compilación del renderer correctos, **20 comprobaciones específicas** y **28 comprobaciones de navegación** en claro y oscuro. Se verifica también autoscroll con 40 chats, cancelación sin escrituras ni ventanas flotantes, y ordenación por teclado sin perder el foco. El JavaScript principal de producción queda en 470,03 kB (150,44 kB gzip); no se han añadido dependencias.

Tras suavizar los iconos y sustituir el lápiz por el divisor con «+», se repiten correctamente TypeScript, la compilación y las **48 comprobaciones de interfaz**. Incluyen simetría de las líneas, centrado, ausencia de saltos al mostrar el control, creación por teclado y panel plegado. Capturas del control visible: `artifacts/sidebar-refinement/dark-creation-divider.png` y `light-creation-divider.png`. El bundle principal queda en 469,66 kB (150,31 kB gzip).

## Compositor centrado y Git bajo demanda

- El campo de escritura tiene un ancho máximo de 780 px, centrado en el área de conversación. Conserva el ancho disponible en ventanas pequeñas y cuando se abren herramientas al lado.
- Se elimina la cabecera que repetía proyecto y chat. El lateral conserva selección, orden, arrastre y renombrado con F2 o clic derecho; Enter guarda y Escape cancela.
- Git aparece abajo a la izquierda como un único control de rama, con indicador de cambios o conflictos cuando procede. El panel que abre reúne ramas, diferencias, commit, sincronización, actualización y aislamiento/worktree. Se ajusta a la ventana y se cierra con Escape o al hacer clic fuera.
- El estado de Git permanece en un componente estable por repositorio/worktree. Colocar su interfaz en el pie del compositor mediante un portal evita perder operaciones o el borrador de commit cuando se sustituye el compositor al cambiar de chat.

Verificación: **275/275 pruebas de lógica**, TypeScript y compilación de producción correctos, **46 comprobaciones específicas de interfaz** (26 de navegación y 20 del lateral), y recorridos de chat compacto, multichat, chats nativos y terminal/Git nativos correctos. Se prueban tamaños de 2200, 760 y 480 px, panel de Git con cambios y conflictos, foco, renombrado y conservación del estado de Git entre chats. Capturas: `artifacts/project-navigation/dark-2200.png`, `light-2200.png` y las variantes `*-git.png`. El JavaScript principal queda en 474,05 kB (151,45 kB gzip).

Tras añadir el acordeón por proyecto pasan TypeScript, compilación y **50 comprobaciones de interfaz** (26 de navegación y 24 del lateral). Se verifica plegado independiente, persistencia, teclado, contenido oculto fuera del foco, conservación de borradores y orden, movimiento reducido, doble clic del panel y creación de chat desde un proyecto plegado. Capturas: `artifacts/sidebar-refinement/dark-project-accordion.png` y `light-project-accordion.png`.

La separación posterior de gestos pasa TypeScript, compilación y las **26 comprobaciones de navegación**: solo el doble clic en la zona libre pliega el panel; en el nombre del proyecto renombra, conserva el acordeón y permite guardar o cancelar. F2 sigue disponible.

## Último repaso de componentes

La revisión final mantiene la estética acordada: iconos de proyecto rellenos, estados de contorno fino, color suave al completar, acciones visibles al pasar por cada bloque y escritura con un máximo de 780 px. Se ha revisado el lateral, conversación, multichat, ventanas flotantes, Git/worktrees, búsqueda, avisos, bienvenida, ajustes, cuentas, temas, navegador, terminal y divisores.

Correcciones de esta pasada:

- Multichat, ventanas flotantes y equipos reutilizan los mismos indicadores de estado que el lateral. Se eliminan las antiguas bolitas y sus reglas CSS.
- Las ventanas flotantes recuperan sus márgenes laterales de 12 px; los botones de su cabecera quedan discretos. El menú de ventana se cierra cuando el foco sale de él.
- El compositor de multichat comparte los 780 px de superficie de escritura y su indicación vacía no se parte en una segunda línea recortada.
- Renombrar un proyecto devuelve el foco a su botón sin quitárselo a otro control elegido por el usuario. Enter durante composición de texto no confirma el nombre prematuramente.
- Git ajusta textos largos al panel, usa el color neutro de la interfaz para el aislamiento y corrige los contadores singulares. El cierre anuncia el atajo Escape.
- Escape cierra las opciones del navegador desde toda su barra. El estado de carga del terminal respeta su visibilidad y mantiene el contenedor.
- Los mensajes largos anuncian su estado expandido. El editor de estilos incluye todos los CSS nuevos y conserva su carga bajo demanda.

Se actualizaron las pruebas que todavía buscaban pestañas superiores o botones de plegado retirados. Las fixtures de Git incluyen el estado completo, ya que su panel permanece montado para conservar operaciones y borradores. Las pruebas nativas finales usan la compilación estable, evitando que una recarga de desarrollo interrumpa el recorrido.

La compilación completa (`npm run build`), **275/275 pruebas de lógica** y los **24 recorridos de interfaz** enumerados abajo pasan. El bundle JavaScript principal final ocupa **475,88 kB**, **151,92 kB gzip**; sigue por debajo de los 543,06 kB iniciales, sin añadir dependencias. No se ha medido la memoria total del proceso Electron en esta pasada.

Para repetir los recorridos de interfaz con datos temporales, después de compilar:

```bash
SOURCE_BUILD=1 node scripts/ui-regression.mjs project-navigation sidebar-refinement design-audit ui-polish state-sync onboarding settings-polish interface attention chat-design chat-interactions multichat team compact-chat floating-chat attachments response-actions browser browser-ux browser-tabs workspace worktree-ui navigation tabs
```

La cobertura incluye claro y oscuro, alto contraste, movimiento reducido, teclado, nombres largos, ventanas estrechas, arrastre, renombrado, foco, confirmaciones, conservación de borradores, Git y procesos de terminal. Las capturas quedan en `artifacts/` y los recorridos ejecutados con el coordinador escriben sus logs en `artifacts/v20/`. Las cuentas y respuestas de proveedor usadas por estas pruebas son simuladas; los cambios no publicados del otro ordenador quedan pendientes de integración.
