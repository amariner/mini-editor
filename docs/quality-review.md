# Revisión de calidad · 22 de octubre de 2026

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
