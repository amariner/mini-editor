# Revisión de calidad · 22 de octubre de 2026

Base de trabajo: `fd8040d` en `main`. Rama: `codex/app-quality-review`.

## Integración con el otro ordenador

Los cambios de ese ordenador podrían seguir sin subir. Esta rama no presupone que estén incluidos: conserva el protocolo IPC 42, los formatos guardados y las dependencias del proyecto. Las modificaciones se agrupan en commits para facilitar su revisión y combinación.

Antes de integrar, guarda el trabajo del otro ordenador en su propia rama con commits y conserva cualquier archivo local que Git ignore. Después trae ambas ramas al mismo repositorio. Crea una rama de integración desde el desarrollo más reciente y combina `codex/app-quality-review` mediante un merge normal; resuelve cada conflicto conservando las funcionalidades de ambos lados. Evita reemplazar carpetas completas por esta copia.

La rama queda local, sin publicar. El archivo `artifacts/agent-desk-quality.bundle` permite trasladar los commits sin copiar carpetas de desarrollo ni datos privados. El repositorio de destino debe contener la base `fd8040d` (si falta, actualiza sus referencias desde GitHub). Desde ese repositorio puedes importar la rama con:

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
- `src/team.tsx`, `src/git-bar.tsx` y los nuevos componentes de navegación: las conversaciones pasan del antiguo tabulador superior al panel de proyectos y al selector del compositor. Los gestos de ventana flotante reutilizan la acción IPC existente.

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
- Doble clic en el panel o en el nombre/icono del proyecto pliega o expande la barra. ⌘B ofrece el mismo control por teclado y F2 permite renombrar. En el panel plegado el icono queda libre para seleccionar y expandir; ⌘N crea un chat.
- El lápiz del proyecto crea conversaciones y se alinea con el estado de sus chats. Al pasar por un chat, la X de eliminación sustituye la bolita en su misma posición; conserva la confirmación antes de borrar.
- Se retiran las pestañas superiores. El nombre del chat aparece junto al proyecto en el compositor, con un menú que permite navegar por todas las conversaciones del proyecto y renombrar. El aislamiento se configura dentro del panel de Git/worktree inferior.
- Crear o eliminar conversaciones no borra el estado de Git del mismo repositorio ni deja la barra en «Consultando…» hasta el siguiente sondeo.
- Los chats de la misma carpeta comparten el estado de las operaciones Git y su borrador de commit. El selector devuelve el foco al nuevo chat cuando está disponible; cualquier interacción posterior cancela esa devolución para respetar la intención del usuario.
- Arrastrar un chat fuera del panel, del selector inferior o de la cuadrícula muestra una tarjeta elevada y permite abrir una ventana flotante al soltar. Escape, perder el foco o soltar dentro cancelan la separación; Alt+Mayús+F ofrece acceso por teclado. La cuadrícula conserva su ordenación interna.

Verificación de esta iteración: **269/269 pruebas de lógica** y **28 comprobaciones nuevas de navegación**, en claro y oscuro y con anchos de 1280, 760 y 480 píxeles. Incluyen geometría, hover, foco, borradores, creación/eliminación, worktree, desbordamiento y cancelación del arrastre. Registro y capturas: `artifacts/project-navigation/`.

```bash
SOURCE_BUILD=1 node scripts/project-navigation-check.mjs
```

La comprobación compila el renderer en una carpeta temporal para no interferir con la aplicación de desarrollo abierta.

También pasan los recorridos de multichat, estilo/foco en claro y oscuro, navegación nativa, ventanas flotantes nativas y ciclo de vida de chats (`tabs-check.mjs`, adaptado al nuevo selector). Este último comprueba foco por teclado, cancelación al interactuar, borradores, procesos activos, terminal y eliminación confirmada. Para los recorridos de Electron mientras `npm run dev` está abierto, usa `SOURCE_DEV_URL=http://127.0.0.1:5173`; sus perfiles y datos siguen siendo temporales. La aplicación valida ese origen, por lo que un servidor de preview en un puerto aleatorio no sirve para esas pruebas nativas.
