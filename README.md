# Agent Desk

Aplicación local para macOS: una ventana Electron con tus proyectos, cuentas independientes de Claude Code, Codex, OpenRouter y Google · Gemini (sin cuentas precreadas). Claude funciona como un **chat nativo equivalente a Claude Code** (streaming, herramientas, permisos, preguntas, comandos, modelo, permisos y esfuerzo desde el compositor) y conserva su terminal oficial como modo opcional. La interfaz está en español, con un diseño plano y claro.

## Modelos locales, sin Ollama

En **Ajustes → Cuentas → Añadir cuenta**, elige **Local · En este ordenador**. Selecciona la carpeta raíz de tus modelos (también se exploran sus subcarpetas), descarga el motor y después importa un archivo GGUF o descarga uno mediante su enlace directo de Hugging Face (`/resolve/…/modelo.gguf`). El botón de Qwen 3.5 9B prepara un enlace de Unsloth; la descarga empieza al pulsar **Descargar en la carpeta elegida**. Los archivos originales importados se conservan y los modelos se pueden mover a la papelera desde esta pantalla.

Activa **Permitir herramientas del proyecto** para que un modelo compatible pueda listar, leer y escribir archivos en la carpeta del proyecto de cada chat. La ruta del proyecto se envía siempre al modelo y el listado devuelve la ruta absoluta de la carpeta; la biblioteca de modelos es una carpeta distinta. Las escrituras, los comandos y las lecturas fuera del proyecto solicitan aprobación en el chat. Con el interruptor desactivado, el modelo funciona en modo conversación y las instrucciones explican cómo activar las herramientas. El ajuste se aplica al siguiente mensaje, también en chats abiertos.

La descarga muestra actividad inmediata, progreso en MB y cancelación junto al botón del motor. Los errores permanecen visibles para poder corregirlos y reintentar. Tanto el motor como los modelos respetan **Ajustes → Red**, incluida la autenticación del proxy; si este no responde, hay que revisar su configuración o la conexión corporativa. `node scripts/local-download-check.mjs` comprueba la interfaz de descarga después de compilar, y `node scripts/download-proxy-check.mjs` verifica el transporte con un proxy autenticado de prueba.

Para volver al entorno de pruebas local separado de tus cuentas habituales, usa `npm run dev:local` (datos en `artifacts/local-dev/data`).

Los GGUF válidos de la carpeta y sus subcarpetas aparecen en el selector del chat, identificados por su ruta relativa para distinguir nombres repetidos. No se copian los modelos que ya están dentro de esa biblioteca. Los grupos de archivos divididos solo aparecen cuando están completos; los proyectores y los archivos de otros formatos no se ofrecen como modelos de texto. Agent Desk arranca llama.cpp al enviar el primer mensaje, permite una generación local simultánea y libera el modelo tras cinco minutos de inactividad o al pulsar **Liberar memoria**. No hay registro ni API key. El motor oficial está fijado a `b11819` y su descarga se verifica con SHA-256; ocupa alrededor de 39 MB instalado y se guarda en los datos de la aplicación, separado de la carpeta de modelos. La descarga automática del motor requiere macOS Apple Silicon.

El contexto inicial es de 8.192 tokens, configurable entre 2.048 y 131.072. Los modos 64K y 128K usan caché KV cuantizada (8 bits o 4 bits, elegible en ajustes), Flash Attention y un solo slot; el límite de respuesta crece hasta 8.192 tokens dentro de ese contexto. En macOS se comprueba la presión de memoria antes de arrancar y se detiene el motor ante presión crítica o advertencias sostenidas durante 30 segundos con crecimiento de al menos 512 MiB de swap en ese intervalo (o sin poder consultar el swap). Los avisos con swap estable no detienen el motor. Los avisos breves durante la carga no cortan la respuesta. Esto reduce el riesgo de saturación, pero no garantiza una carga determinada: un historial largo también incrementa el tiempo de procesamiento. Se puede elegir un modelo predeterminado para los chats nuevos. Las herramientas se activan expresamente en los ajustes del proveedor y conservan los permisos de lectura externa, escritura y comandos del chat. Esta integración admite modelos GGUF de texto compatibles con esa versión de llama.cpp; no habilita imágenes, proyectores multimodales ni PDF nativo. Los GGUF divididos necesitan todas sus partes en la misma carpeta. Internet solo se necesita para las descargas y para herramientas que accedan a la red.

Después de compilar, `node scripts/local-check.mjs` verifica creación de cuenta, selección de carpeta, catálogo recursivo, modelo predeterminado anidado y chat con un motor sintético y datos temporales. En la revisión 0.1.1 también se comprobó inferencia real en un Mac de 32 GB con Qwen 3.5 9B, Qwen 3.6 27B, Devstral Small 2 24B y Gemma 4 26B A4B (GGUF Q4, uno a uno, contexto de 2.048 tokens y respuesta corta). Esa prueba confirma carga y respuesta, no calidad de razonamiento ni viabilidad del contexto máximo. `npx tsx --test tests/local.test.ts` comprueba descargas, cancelación, persistencia, arranque, autenticación local y exclusión entre chats.

La comprobación local incluye listado, lectura y escritura real de un archivo temporal, verificando que no se crea hasta aprobarla. `CHECK_EXECUTABLE` permite ejecutar la misma prueba sobre una app empaquetada. En la revisión 0.1.3, Gemma 4, Qwen 3.6 y Qwen 3.5 superaron además una prueba con pesos reales de lectura, copia exacta y ruta del proyecto. Gemma también creó un HTML y retomó un chat con una negativa de acceso anterior. Devstral ejecutó las herramientas y escribió el archivo, pero omitió contenido que debía copiar; el acceso funciona, aunque el modelo no garantiza fidelidad en sus respuestas.

## Chats flotantes

El botón **Sacar chat** (ventana con un recuadro) está en la barra de conversaciones y en el menú de cada tarjeta del multichat. Abre una ventana nativa independiente con la conversación y el compositor juntos. Puedes sacar varios chats, arrastrarlos por la cabecera y cambiar su tamaño desde los bordes. Cada uno sigue vinculado a su conversación aunque cambies de proyecto en el editor.

La ventana toma el **color de la cuenta** del chat. La cabecera compacta ofrece **Opciones de ventana flotante**, **Volver al editor** y una **X** para cerrar la ventana conservando el chat. Opciones y clic derecho en la cabecera abren el mismo panel: **Siempre encima**, **Opacidad del fondo** (0–100 %), **Intensidad del cristal** (0–200 %) y un interruptor independiente de **Desenfoque** nativo en macOS. La transparencia elegida se conserva al escribir, y el compositor mantiene tamaño, posición y fondo al recibir foco. La barra de proyecto, cuenta y uso queda en el editor principal. La posición, tamaño y preferencias se guardan por conversación; los ajustes continuos agrupan las escrituras a disco. Los borradores y adjuntos se comparten entre ambas vistas. Los borradores de texto sobreviven al reinicio; los adjuntos pendientes pertenecen a la apertura actual de la aplicación.

Al activar la ventana principal del editor se ocultan temporalmente todas las ventanas flotantes. Al pasar a otra aplicación reaparecen sin quitarle el foco; abrir o mostrar cualquiera de los chats flotantes recupera todo el grupo. Los chats ocultos siguen funcionando y conservan sus borradores y posiciones.

La forma se puede cambiar en **Ajustes → Interfaz → Estilos (CSS)** con variables: `--floating-radius` (esquinas), `--floating-gutter` (márgenes interiores), `--floating-header-height`, `--floating-composer-radius` y `--floating-background` (sustituye el color de la cuenta). `--floating-opacity` permite fijar la opacidad por CSS por encima del control de la ventana; `--floating-solid` establece la opacidad mínima al usarla. Por ejemplo, `:root { --floating-opacity: 60%; --floating-solid: 60%; }` mantiene el fondo al 60 % incluso al escribir. El fondo del compositor admite `--floating-composer-opacity`; el panel de opciones permanece opaco para facilitar la lectura. El tema **Original** incluye todos estos componentes, los estilos del terminal y las animaciones. Guardar o restablecer CSS actualiza también las ventanas flotantes que ya están abiertas.

Verificación aislada: `npm run build && node scripts/floating-chat-check.mjs` y `node scripts/floating-appearance-check.mjs`. Comprueba ventanas simultáneas, IPC, aislamiento de conversación, borradores y adjuntos, transparencia, tamaño, retorno al editor y cierre nativo. También forma parte de `node scripts/ui-regression.mjs`.

## Navegador y atención al trabajo en curso

El navegador tiene una barra compacta con navegación, dirección y **…**. Zoom, abrir fuera, suspender y añadir contexto al chat se agrupan en ese desplegable; el botón de nueva pestaña queda junto a las pestañas. Las aperturas y los clics tienen transiciones breves (140–180 ms) y respetan **Reducir movimiento**. La vista nativa conserva su posición, sus bordes redondeados y su contenido al navegar; cambiar una URL no provoca un ciclo de ocultar y mostrar. La dirección que estás escribiendo se conserva frente a una navegación del agente; `Esc` recupera la URL actual.

**… → Al chat** prepara una captura real y el texto visible de la página en el borrador del chat actual. Conserva el texto y los adjuntos que ya tenías, limita la referencia a 6000 caracteres y nunca envía la tarea automáticamente. Sólo está disponible entre pestaña y chat del mismo proyecto; no admite chats en modo terminal. Si la página cambia durante la captura, pide repetirla para no mezclar evidencias. El resultado queda editable antes de enviarlo al proveedor.

El **Centro de atención** reúne permisos, preguntas, errores, mensajes sin enviar y respuestas pendientes de leer entre proyectos y proveedores. Su botón aparece cuando hay algo por revisar; `⌘⇧A` también lo abre cuando está vacío. Prioriza lo que bloquea a los agentes y muestra el contexto de la solicitud, el proveedor y los cambios del último turno cuando existen. Elegir una fila abre el chat original para decidir allí. El historial antiguo no genera alertas al iniciar; las respuestas que terminan en segundo plano, incluso sin crear un mensaje nuevo, quedan pendientes hasta abrir el chat. Las marcas de lectura son locales a esta apertura de la aplicación.

Verificación específica después de `npm run build`: `node scripts/browser-ux-check.mjs` comprueba geometría nativa, ausencia de parpadeos por ocultación, borradores y captura real, aislamiento, teclado y tamaños compactos. `node scripts/attention-check.mjs` comprueba prioridad, finalización en segundo plano, foco, navegación, temas y movimiento reducido. Ambas forman parte de `node scripts/ui-regression.mjs` y utilizan datos de prueba aislados.

## Ajustes v20

La interfaz prioriza el contenido y deja las acciones secundarias a un clic. En Multichat, cada cabecera conserva título, ampliar y **…**; ese menú reúne puertos de desarrollo, renombrar, duplicar, refrescar Git, ocultar y eliminar. El plan y los subagentes se despliegan bajo demanda. El grid conserva el último mensaje al cambiar de tamaño y respeta la posición si estás leyendo mensajes anteriores; una flecha permite volver al final. Una tarjeta única se centra con ancho de lectura limitado.

**Cerrar una pestaña conserva el historial y el borrador.** Si tiene un agente abierto, se confirma su parada. **Eliminar chat**, en el menú de la tarjeta, borra la conversación y los adjuntos tras una confirmación explícita. **Ocultar** solo cambia la visibilidad en el grid.

En Ajustes, las opciones de cada cuenta reúnen color, cuenta predeterminada, ahorro y acciones de sesión. Interfaz agrupa los colores personalizados y el editor de temas; Red agrupa credenciales y certificados. Los diálogos mantienen el foco de teclado y lo devuelven al control que los abrió. Las pestañas aceptan flechas, Inicio y Fin, y la barra de proyectos recuerda si estaba plegada.

La actividad de turnos terminados queda junto al resumen de herramientas, sin repetir la respuesta. Los turnos interrumpidos sin respuesta final conservan su progreso visible. Los permisos, errores y mensajes pendientes siguen accesibles. Se mantienen fuentes, colores, CSS personalizado, temas, proveedores y acciones del chat.

Después de compilar, `node scripts/ui-regression.mjs` recorre las comprobaciones de componentes con datos temporales y guarda resultados y capturas en `artifacts/v20/`. Se pueden elegir comprobaciones, por ejemplo `node scripts/ui-regression.mjs ui-polish tabs multichat`. Las pruebas no usan las conversaciones personales ni envían tareas a modelos.

## Arrancar

```bash
npm ci
npm run dev
```

`npm ci` instala localmente los paquetes oficiales de Claude Code, Gemini CLI y OpenCode, el Agent SDK de Claude y recompila `node-pty` para Electron. No instala herramientas globales ni copia configuraciones existentes. Requiere Node 22.12+ (probado con 26.8.1), npm y Git.

En macOS, el editor restaura el permiso de ejecución del `spawn-helper` de `node-pty` antes de abrir terminales. Algunos precompilados lo instalan sin ese permiso y provocan `posix_spawnp failed.` al iniciar sesión en Claude o abrir una consola.

Compilación local sin servidor de desarrollo:

```bash
npm run build
npm start
```

`npm run dev` inicia Vite en `127.0.0.1:5173`, compila main/preload y abre Electron. React recarga en caliente. Los cambios en main/preload se recompilan y muestran **Actualización preparada**: detén las sesiones abiertas y pulsa **Actualizar aplicación** para reiniciar Electron conservando Vite. Nunca se reinician agentes automáticamente. La interfaz comprueba la versión del proceso principal antes de ejecutar funciones nuevas. Si ya tenías abierta una versión anterior sin este mecanismo, sal con **⌘Q** y ejecuta de nuevo `npm run dev`; cerrar solo la ventana mantiene el proceso antiguo vivo.

## Instalador local para macOS

### Qué se guarda en GitHub

El instalador se genera **en el Mac que ejecuta el empaquetado**. La carpeta `release/` está excluida en `.gitignore`: sus `.dmg` y `.app` no se añaden a los commits ni se suben con `git push`. Descargar o clonar el código desde GitHub no incluye el instalador generado en otro equipo.

Este flujo no publica instaladores automáticamente. Para distribuir uno sin que quien lo recibe tenga que compilar, se puede compartir el `.dmg` generado o adjuntarlo manualmente a una **Release de GitHub**. Es una publicación separada del código; `npm run package:mac` solo crea archivos locales.

### Generar el instalador después de descargar el proyecto

Necesitas un **Mac con sesión gráfica abierta**, Node 22.12+, npm y Git. La instalación inicial de dependencias requiere conexión a Internet; reserva varios GB libres para Electron, los CLI y los archivos temporales del empaquetado. El comando de empaquetado usa las herramientas de macOS (`codesign`, `hdiutil`, `ditto` y `PlistBuddy`); no se ejecuta en Windows ni Linux.

Descarga y descomprime el proyecto, o clona el repositorio. Abre una terminal **dentro de la carpeta del proyecto**, donde está `package.json`, y ejecuta:

```bash
npm ci
npm run package:mac
```

`npm ci` instala las dependencias fijadas en `package-lock.json` y ejecuta su preparación, incluidos los binarios de los proveedores y `node-pty`. No uses `--ignore-scripts`: algunos ejecutables incluidos necesitan esos pasos de instalación. No hace falta ejecutar antes `npm run dev` ni `npm run build`; el empaquetado comprueba TypeScript, compila y prueba su propia copia de la app.

Al terminar, imprime las rutas del instalador y de la aplicación. El nombre toma la versión de `package.json` y la arquitectura de Node que ejecuta el comando:

| Entorno de compilación | Instalador | Aplicación sin imagen de disco |
| --- | --- | --- |
| Apple Silicon, Node ARM64 | `release/Agent-Desk-<version>-mac-arm64.dmg` | `release/mac-arm64/Agent Desk.app` |
| Intel, Node x64 | `release/Agent-Desk-<version>-mac-x64.dmg` | `release/mac-x64/Agent Desk.app` |

Por ejemplo, la versión `0.1.0` en Apple Silicon genera `release/Agent-Desk-0.1.0-mac-arm64.dmg`. La comprobación inicial se realizó en Apple Silicon; este comando no genera un paquete universal ni compila ambas arquitecturas a la vez. Utiliza Node y Electron de la misma arquitectura y genera el paquete correspondiente al Mac de destino. Repetir el comando con la misma versión y arquitectura sustituye los archivos de salida anteriores.

### Instalar y abrir

1. Abre el `.dmg` generado.
2. Arrastra **Agent Desk.app** a **Applications** (Aplicaciones).
3. Abre **Agent Desk** desde Aplicaciones. Después puedes expulsar la imagen de disco.

Quien recibe el `.dmg` puede seguir estos pasos sin descargar el repositorio ni ejecutar npm. La app incluye Electron, las dependencias de producción, Claude Code, Gemini CLI, OpenCode, el SDK de Claude y un ejecutable Node basado en Electron; no requiere Node global para abrirse. Git y los CLI externos de Codex, Antigravity y Freebuff se detectan en el equipo o se seleccionan en **Ajustes → Herramientas y datos locales**. Codex también se busca dentro de ChatGPT.app (`/Applications`, `~/Applications`, `~/Aplicaciones`).

El instalador tiene **firma local ad hoc**, sin cuenta Apple Developer, App Store ni notarización. Si macOS bloquea la primera apertura, intenta abrir la app y ve a **Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente**, según [las instrucciones de Apple](https://support.apple.com/es-es/102445).

### Convivencia con desarrollo

| | Desarrollo | Instalada |
| --- | --- | --- |
| Cómo abrir | `npm run dev` desde el proyecto | Agent Desk desde Aplicaciones |
| Título de ventana | Agent Desk · Desarrollo | Agent Desk |
| Datos locales | `~/Library/Application Support/Agent Desk` | `~/Library/Application Support/Agent Desk Installed` |
| Cambios de código | Recarga de React y actualización del proceso principal descritas en «Arrancar» | Conserva la versión con la que se generó el instalador |

Pueden abrirse simultáneamente: cada una tiene su estado de cuentas, conversaciones, ajustes y bloqueo de instancia. La instalada empieza vacía, sin importar datos o accesos de desarrollo. `npm run build` seguido de `npm start` sigue siendo una ejecución desde el proyecto y utiliza los datos de desarrollo; no instala una `.app`.

Los archivos de un proyecto siguen siendo los mismos si lo añades a ambas versiones. Además, los CLI externos que comparten la sesión del usuario de macOS, como Antigravity y Freebuff, mantienen ese comportamiento: separar los datos de Agent Desk no crea otra sesión independiente en esas herramientas. `AGENT_DESK_DATA_DIR` y `AGENT_DESK_PROFILES_DIR` permiten elegir directorios explícitos para pruebas; evita apuntar ambas versiones al mismo directorio si buscas mantenerlas separadas.

El empaquetado compila en un directorio temporal, sin sustituir `dist` ni `dist-electron` usados en desarrollo. Una vez copiada a Aplicaciones, la app instalada funciona independientemente de la carpeta del repositorio y del `.dmg`.

### Actualizar la app instalada

1. Actualiza el código del proyecto. Si has descargado una revisión nueva, ejecuta `npm ci` para sincronizar las dependencias.
2. Ejecuta `npm run package:mac` y espera a que termine correctamente.
3. Sal de la **app instalada** con **⌘Q**; cerrar solo la ventana puede dejar el proceso abierto.
4. Abre el nuevo `.dmg` y sustituye **Agent Desk.app** en Aplicaciones.
5. Abre la app desde Aplicaciones. Sus datos se conservan en `Agent Desk Installed`.

Los cambios de desarrollo no llegan automáticamente a la instalada. No hay descarga automática de actualizaciones ni publicación automática en GitHub: hay que repetir la generación y sustitución de la `.app`.

### Verificación y problemas de empaquetado

Antes de generar el disco, el comando comprueba la firma local y abre la app real desde otra carpeta con datos temporales: carga de la interfaz, herramientas incluidas, SDK de Claude, terminal nativa, Node incluido, bloqueo de instancia y convivencia con Electron de desarrollo. Después genera el `.dmg` y verifica su integridad con `hdiutil verify`. Una comprobación fallida hace que el comando termine con error; espera al mensaje final con las rutas antes de usar el instalador.

Para repetir la comprobación de la `.app` ya generada:

```bash
npm run test:package
```

No usa cuentas reales ni envía consultas a modelos. Guarda una captura en `artifacts/package-mac.png`.

Si faltan dependencias o ejecutables de un proveedor, vuelve a ejecutar `npm ci` sin omitir los scripts de instalación y repite `npm run package:mac`. Si falla la apertura de las ventanas de prueba, ejecuta el comando en la sesión de escritorio del Mac, con permisos para abrir aplicaciones y conexiones locales. Para este flujo no necesitas certificados Developer ID ni credenciales de Apple.

### Tamaño del paquete

El empaquetado copia solo el grafo de dependencias de ejecución externas: los módulos que Vite/esbuild ya integran en los bundles no se copian otra vez. Se excluyen mapas de código, declaraciones TypeScript, cachés y fuentes/precompilados nativos de otras plataformas. Conserva las licencias y los recursos de ejecución de los CLI.

Los instaladores de Claude y OpenCode crean enlaces a sus ejecutables; copiar las carpetas sin conservar esa relación generaba tres copias de Claude y dos de OpenCode. Ahora se comparan los bytes mediante SHA-256 y se sustituyen las copias idénticas por enlaces relativos internos que siguen funcionando al mover la app a Aplicaciones. Si las versiones difieren, se conservan ambos ejecutables. Con las dependencias actuales en ARM64, `node_modules` empaquetado pasa de 1.319.591.841 a 544.190.208 bytes (−58,8%). El DMG usa UDZO con compresión zlib de nivel 9. No se empaquetan cuentas, historiales ni cachés del usuario.

Medición local del 21 de octubre de 2026: el DMG pasa de 746,9 a aproximadamente 343,1 MB (−54,1 %); la app ocupa unos 798 MiB en disco. La mayor parte restante corresponde a Electron y a los ejecutables oficiales de Claude, OpenCode y Gemini incluidos para funcionar sin instalar herramientas adicionales. El tamaño depende de la arquitectura y de las versiones fijadas en el lockfile.

## Inicio y consumo de recursos

Sin cuentas, la ventana muestra únicamente **Añadir cuenta**, centrado respecto a toda la ventana. Después aparece **Añadir proyecto**; Ajustes y plegar/expandir quedan abajo a la izquierda, sin reservar una columna vacía. La barra de proyectos aparece al añadir el primero. Freebuff añadido desde Ajustes también permite pasar al paso del proyecto.

El acceso a Multichat aparece cuando existe algún chat y se cierra al eliminar el último. Incluye también conversaciones guardadas que todavía no se han abierto en esta ejecución. Ocultar el grid desmonta sus tarjetas e historiales, conservando borradores, orden y conversaciones.

El icono del navegador necesita una página vinculada al proyecto o un puerto local confirmado. Si desaparece el último destino disponible, el panel se cierra. Detectar un puerto solo registra una pestaña suspendida: no carga Chromium ni abre la web hasta que se usa. Los enlaces web solicitados explícitamente desde un chat siguen disponibles. El terminal, los ajustes y el panel del navegador cargan su código bajo demanda; el bundle inicial pasa aproximadamente de 914 a 538 kB sin comprimir.

La revisión de recursos también reduce consultas Git a resúmenes sin parches cuando el panel de cambios está cerrado (cada 30 s en la vista habitual, 15 s con herramientas/grid visibles), evita el sondeo Git sin proyecto y el de puertos sin destinos locales, comparte comprobaciones TCP simultáneas y libera pestañas al borrar chats/cuentas. La caché de archivos conserva como máximo ocho proyectos durante 20 s; los buffers de detección de URLs están acotados y se limpian al eliminar su contexto. Persistir un estado idéntico ya no reescribe el archivo en disco.

El navegador mantiene los límites existentes de 60 pestañas guardadas y seis páginas cargadas. Los buffers de terminal ya estaban limitados a dos millones de caracteres por chat y 150.000 por terminal de cuenta. Los historiales completos siguen formando parte de los snapshots/IPC y de la serialización del estado: paginarlos o enviar deltas sería una mejora adicional para historiales grandes. Esta revisión conserva el historial y no borra cachés personales ni cookies.

Verificación: `npm test` incluye poda/deduplicación del paquete, disponibilidad del inicio/navegador, descubrimiento sin Chromium, liberación de recursos, cachés y resumen Git. `node scripts/onboarding-check.mjs` comprueba el recorrido y su centrado en dos tamaños; `node scripts/multichat-check.mjs`, `node scripts/browser-check.mjs` y `node scripts/browser-tabs-check.mjs` cubren interacciones y navegación. Son pruebas con datos temporales, sin inferencia. Reinicia las instancias antiguas para usar el nuevo contrato de resumen Git (IPC 42).

## Vista Multichat

El botón de cuadrícula de la esquina superior derecha abre **Multichat**, con mini chats de todos los proyectos. Cada tarjeta tiene historial con scroll independiente, mensajes en directo, proyecto, cuenta y estado. Escribe y pulsa **Enter** para enviar; **Shift + Enter** añade una línea. Puedes adjuntar archivos, interrumpir ese chat y responder sus permisos y preguntas dentro de la tarjeta: aparecen fijos encima del campo de mensaje, con los botones de decisión justo bajo el título, y el historial cede su espacio mientras esperan. El campo crece con el texto hasta unas seis líneas. Los borradores y adjuntos se comparten con el chat completo y se conservan si falla el envío. El envío durante una respuesta respeta las capacidades de cada proveedor: Claude admite mensajes en cola; los demás esperan a terminar.

El contenido usa el mismo renderizado que el chat ampliado: negritas, listas, tablas, código con resaltado y enlaces destacados, junto con el resumen de herramientas y las acciones de copiar y leer respuestas. El historial se carga por grupos de conversación para conservar respuestas y tablas completas. Los enlaces web se abren como en el chat ampliado; las rutas de archivos y las acciones de terminal se dirigen al proyecto de su tarjeta. El acceso a puertos en el menú de la tarjeta sigue abriendo Chrome.

Un punto antes del título indica el estado: azul trabajando, naranja requiere atención, rojo error y verde terminado. Debajo, la línea de contexto muestra el nombre personalizado de la cuenta, la carpeta y la rama de Git, y solo añade archivos cambiados, conflictos, líneas añadidas/eliminadas y commits por subir o bajar cuando no son cero. El estado de Git se consulta una vez por proyecto y se comparte entre sus tarjetas; la acción para actualizarlo está en el menú **…** de la tarjeta. Justo debajo aparece la actividad del agente: archivo, comando o búsqueda en curso, último paso, tiempo del turno y número de pasos y errores. Pulsa esa línea para desplegar el registro.

Entre la línea de contexto y el historial, los controles de **supervisión** resumen lo que importa con muchos chats a la vez: el progreso del plan (TodoWrite o plan del proveedor) con su barra y el paso en curso; un chip con los archivos cambiados y las líneas +/− desde tu último mensaje, que abre sus cambios; y, en Claude, una línea con los subagentes en marcha y su último resumen de progreso. Cuando Claude termina un turno puede proponer la siguiente petición como un chip sobre el campo, en la tarjeta y en el chat completo: pulsarlo la copia al borrador, nunca la envía, y solo aparece con el campo vacío. Ambas funciones (`agentProgressSummaries` y `promptSuggestions` del Agent SDK) reutilizan la caché del prompt. El historial completo sigue debajo.

El botón **+** de la barra del grid crea un chat eligiendo proyecto y cuenta sin salir del grid; su tarjeta aparece al final, lista para escribir, sin mover las demás. En macOS, el icono del Dock muestra cuántos chats requieren atención (permisos, preguntas o errores).

Cada puerto local anunciado en la salida de herramientas de un chat y comprobado como activo añade una acción **Abrir en navegador** en el menú **…** de la tarjeta. Cada acción abre su URL directamente en **Google Chrome**, conservando el grid y su selección. Si Chrome no está disponible, muestra el error sin abrir otro navegador. Se cuenta una vez cada puerto por chat, aunque aparezcan varias URLs del mismo puerto; cerrar una pestaña del navegador no elimina la acción. La disponibilidad se revisa cada 15 segundos. Los terminales generales del proyecto no se atribuyen a un chat. La detección de puertos requiere actualizar o reiniciar las instancias de la app abiertas antes de este cambio del proceso principal.

En **Ajustes → Cuentas → Opciones de la cuenta → Color en Multichat**, elige un color y pulsa **Guardar color**. Todas las tarjetas de esa cuenta usan ese fondo y ajustan el texto para mantener su legibilidad. El color se guarda con la cuenta, se conserva al reiniciar y puede retirarse con **Sin color**. Cambiar el color no detiene chats ni cambia la cuenta asignada. La apertura directa en Chrome y el guardado de colores requieren actualizar o reiniciar las instancias anteriores (IPC 31).

El título de una tarjeta se cambia con **doble clic**; **Enter** guarda, **Esc** cancela y salir del campo guarda los cambios. También puedes enfocar el título y pulsar **Enter** o **F2**. La apertura del chat se mantiene en las flechas de ampliar. El título tiene más peso y contraste que los mensajes, y una cabecera y borde suaves separan las tarjetas sin quitar el fondo de su cuenta.

Arrastra la cabecera de una tarjeta sobre otra para cambiar el orden. También puedes enfocar el título y usar **Alt + flechas** para moverla una posición. El orden se guarda en este dispositivo y se mantiene al volver a abrir la app; terminar una tarea o recibir mensajes no mueve las tarjetas.

Los controles del grid ocupan la barra superior para dejar toda la altura a las tarjetas. A la izquierda, un resumen cuenta los chats, los que trabajan, los que requieren atención y los terminados sin revisar; pulsar estos dos últimos salta a la siguiente tarjeta afectada. Una tarjeta queda como **terminada sin revisar** (borde verde) si acaba mientras miras otra, y deja de estarlo al pulsarla o enfocarla.

A la derecha, el selector de distribución abre una cuadrícula de columnas × filas (de 1 a 4 en cada eje) y la opción **Automática**, que es la inicial: ajusta columnas y filas a los chats en marcha y al ancho de la ventana, priorizando tarjetas apaisadas y con un ancho mínimo legible. La elección se guarda en este dispositivo; quien ya había elegido una distribución distinta de 2 × 2 la conserva. Con 4 × 4 se supervisan 16 chats; los demás quedan más abajo con scroll. En ventanas estrechas, una distribución fija puede desplazarse horizontalmente para conservar sus columnas. Cambiar la distribución conserva borradores, procesos y orden de las tarjetas.

`⌘1`…`⌘9` (`Ctrl` fuera de macOS) lleva el foco al campo de mensaje de la tarjeta correspondiente, o a su permiso pendiente; al mantener pulsada la tecla aparecen los números sobre las tarjetas. `Esc` en el campo de una tarjeta lo deja sin foco.

Pulsar un proyecto en la barra lateral sale del grid y abre su último chat visitado; si no se había visitado, recupera el más reciente. Pulsa las flechas de ampliar de una tarjeta para abrir su chat; **Volver al grid** o `Esc` regresa sin interrumpir el agente. Los chats en modo terminal se abren en la vista completa. En la vista habitual, `Esc` conserva su comportamiento de interrupción.

Los resultados permanecen en su sitio al terminar. **Ocultar** en el menú de la tarjeta cambia su visibilidad; el icono **Ver chats ocultos** de la barra permite recuperarla. Se pueden ocultar también chats en marcha sin interrumpirlos. **Eliminar chat** requiere confirmación y elimina su historial y adjuntos, deteniendo antes cualquier agente abierto. Se mantiene el límite de cinco agentes abiertos por proyecto: 16 pueden repartirse entre cuatro o más proyectos.

Verificación visual sin cuentas ni llamadas de modelo: `node scripts/multichat-check.mjs` después de compilar (requiere Chrome instalado). Cubre 16 chats, streaming, envío dirigido al chat correcto, adjuntos, borradores compartidos, fallos de envío, permisos, interrupción individual, arrastrar y soltar, orden por teclado y persistencia, distribución automática y fija, saltos a chats que requieren atención o están sin revisar, atajos numerados, retirados persistentes, actividad detallada y registro de herramientas, nombre de cuenta y Git, múltiples puertos por chat y apertura en Chrome, asignación y retirada de colores por cuenta, navegación entre proyectos, progreso del plan, cambios del turno, subagentes, sugerencias de prompt, chat nuevo desde el grid, tamaños de pantalla y estado vacío. Guarda capturas en `artifacts/multichat-*.png`.

## Primer recorrido

1. **Añadir cuenta** desde la bienvenida. Después, **Añadir proyecto** y elegir una carpeta.
2. La barra lateral contiene solo proyectos, en filas compactas, y puede plegarse desde el icono inferior, junto al icono de Ajustes. Crea tu primera cuenta en **Ajustes → Cuentas → Añadir cuenta** y márcala como predeterminada para los chats nuevos. Las conversaciones se abren en **pestañas**; el `+` o `⌘N` crea otra. El selector debajo del chat permite cambiar la cuenta de esa pestaña antes del primer mensaje. Después queda bloqueado, incluso tras detener o reabrir el chat; para usar otra cuenta hay que crear una pestaña nueva. Hay hasta **5 pestañas por proyecto**: al abrir otra se retira de la barra la inactiva menos reciente, conservando historial y borrador. `⌘K` permite recuperarla. El `+` y la lupa se alinean a la izquierda; al plegar la columna se oculta la lupa. `⌘K` sigue abriendo el buscador. Al plegarla, cada proyecto se identifica por una forma geométrica y un color estables. La `×` cierra una pestaña; si tiene un agente abierto, exige confirmar su parada. Al reiniciar se abre únicamente la conversación seleccionada y el resto queda en la búsqueda. Las pestañas de distintas cuentas conviven en el mismo proyecto. Cambiar la cuenta de un chat nuevo conserva su borrador y adjuntos; cambiar de pestaña o proyecto conserva los procesos y recupera los borradores. La cuenta predeterminada se elige en Ajustes y solo afecta a los chats que se creen después. Si se elimina, la primera cuenta restante pasa a ser la predeterminada.
3. Escribe y envía: Los agentes arrancan automáticamente con el primer mensaje. Si falta autenticación, el borrador se conserva y se muestra el acceso oficial en Ajustes. No hay botones de abrir/detener en la cabecera; la `×` de una pestaña permite cerrar su proceso y `Esc` interrumpe el turno.
4. Abre **Ajustes → Cuentas** para añadir cuentas e iniciar o cerrar sesión, incluso sin proyectos. La primera instalación empieza sin cuentas; añadir un proyecto no crea ninguna. Los accesos del chat también llevan a Ajustes. Claude usa `claude auth login --claudeai` en una terminal integrada dentro de Ajustes; Codex abre el acceso oficial de ChatGPT en el navegador.

## Freebuff CLI

Selecciona un proyecto y abre **Ajustes → Freebuff CLI → Abrir Freebuff en este proyecto**, o pulsa **Freebuff** en la cabecera del terminal. Se abre la CLI oficial en la carpeta del proyecto. Pulsa Enter cuando solicite iniciar sesión y completa su acceso oficial. La cuenta, los modelos disponibles, sus condiciones y los permisos se gestionan dentro de Freebuff; sus conversaciones permanecen en la CLI y no aparecen en el selector de modelos del chat nativo de Agent Desk.

Puedes colocar el panel **A la derecha** o **Abajo**, cambiar su tamaño y alternar con **Consola** sin cerrar Freebuff. Ocultar el panel conserva el proceso; **Detener Freebuff** lo cierra sin detener la consola ni los agentes del chat. Cada proyecto tiene su propio proceso, pero comparte la cuenta local oficial de Freebuff del usuario de macOS. Quitar el proyecto o salir de Agent Desk cierra sus procesos.

En esta instalación se ha instalado **Freebuff 0.2.27** en `~/Library/Application Support/Agent Desk/tools/freebuff`, usando el paquete oficial de npm. La app detecta ese directorio al arrancar y también busca en el PATH; en otros equipos puede instalarse siguiendo [las instrucciones oficiales](https://freebuff.com/cli) y seleccionarse en **Herramientas y datos locales**. Los nuevos procesos reciben la configuración de red de Agent Desk. La app no envía prompts automáticamente ni acepta permisos o condiciones por el usuario.

La activación requiere reiniciar Agent Desk (IPC 28). `node scripts/freebuff-check.mjs`, después de compilar, comprueba la apertura, entrada manual, cambio de panel, aislamiento por proyecto, cierre y persistencia del ejecutable mediante una CLI de prueba. También se verificó el arranque del ejecutable real hasta **Press ENTER to login...**, sin iniciar sesión ni enviar consultas; la disponibilidad de modelos se comprobará al acceder con la cuenta.

## OpenRouter y Google · Gemini

### Google mediante Antigravity

Agent Desk admite **Antigravity CLI (`agy`)** para utilizar Gemini con la sesión Google oficial de Antigravity. En esta instalación se ha descargado la versión **1.3.4** desde el repositorio oficial, comprobado su SHA-512 y guardado en `~/Library/Application Support/Agent Desk/tools/antigravity/1.3.4/agy`, sin modificar el PATH ni los perfiles del shell. La app detecta ese directorio al arrancar. En otros equipos instala la CLI oficial y selecciónala como ejecutable Google en **Herramientas y datos locales**.

En **Ajustes → Cuentas**, crea o reutiliza una cuenta Google y pulsa **Conectar Google con Antigravity**. La app verifica el acceso mediante `/usage`, sin hacer inferencia. Si es necesario iniciar sesión, aparece la terminal oficial: completa el acceso en el navegador y escribe `/exit` para terminar la vinculación. El chat carga los modelos Gemini devueltos por `agy models`, transmite mensajes y respuestas mediante el protocolo público `stream-json` y conserva el identificador de conversación para reanudarlo.

**Alcance de la cuenta:** la CLI comparte la sesión y el Llavero de Antigravity del usuario de macOS. La instalación privada no aísla esas credenciales. Solo se permite una vinculación Google de Antigravity en Agent Desk; `antigravity-link.json` guarda el identificador del perfil, sin tokens. **Desvincular de Agent Desk** elimina esa asociación local y no ejecuta `/logout` ni cierra la sesión de otras instalaciones. Cambiar de cuenta en Antigravity cambia también la sesión que utilizará esta conexión.

**Permisos y adjuntos:** no se activa `--dangerously-skip-permissions`. El chat conserva la política de la CLI; una herramienta que necesita aprobación se rechaza en modo no interactivo. Al bloquearse una herramienta aparece la tarjeta **Gemini necesita tu permiso**. **Revisar y continuar** reanuda la misma conversación y abre el panel **Gemini · permisos y ejecución** dentro de la ventana, enviando la petición de continuación mediante `--prompt-interactive`. No abre otra pestaña ni la consola del proyecto; las aprobaciones se responden en el panel oficial y no se aceptan automáticamente. Ocultar el panel mantiene la sesión activa. La terminal se ajusta al espacio visible, descontando los márgenes para mantener completos el pie y los menús. **Cambiar modelo** muestra cómo abrir el selector oficial con `/model` e Intro, elegir con las flechas y confirmar; no envía teclas ni modifica el borrador. **Leer pantalla larga** permite consultar interfaces extensas mediante **Inicio/Final**, incluso cuando la CLI usa el búfer alternativo; **Ajustar al panel** devuelve el tamaño normal sin reiniciar la sesión. También conserva **Ampliar/Reducir** y el panel lateral. Los controles de lectura no envían teclas de aceptación a Antigravity. Los rechazos se muestran como herramientas fallidas, con un aviso al final del turno; no quedan marcados como una ejecución en curso. **Detener y volver al chat** cierra la ejecución interactiva y recupera el chat nativo; las interacciones realizadas en la terminal permanecen en el contexto de Antigravity, aunque no se importan al historial visible de Agent Desk. El protocolo público de entrada admite texto; para archivos existentes indica su ruta en el proyecto. Los adjuntos se rechazan con un aviso explícito. Los chats antiguos de Gemini CLI se conservan y requieren un chat nuevo para Antigravity.

Verificación: `tests/antigravity.test.ts` comprueba vinculación única, catálogo Gemini, conversación, tokens, cancelación y conservación del historial. `node scripts/antigravity-check.mjs` comprueba la interfaz con un CLI simulado, incluida la terminal y la persistencia tras reinicio. También se verificaron dos turnos reales con Gemini 3.8 Flash Low y recuperación del contexto. La activación requiere reiniciar la app (protocolo IPC 27).

### Conexiones anteriores

En **Ajustes → Cuentas → Añadir cuenta**:

- **OpenRouter · API**: introduce tu clave en el campo de contraseña de la tarjeta y pulsa **Conectar OpenRouter**. La clave se verifica con `/api/v1/key` y se guarda cifrada mediante `safeStorage` en el directorio del perfil; no se devuelve al renderer ni se escribe en `state.json`. Si la verificación de una nueva clave falla, se conserva la anterior. Abre **Modelos que quieres probar**, carga el catálogo, filtra por uso (incluido **Programación**), activa opcionalmente **Mostrar solo modelos gratuitos**, marca los modelos y guarda. Los elegidos aparecen en el selector del chat; con el filtro gratuito activado no se envían peticiones a los modelos de pago seleccionados. El catálogo y los precios proceden de OpenRouter; las categorías usan su filtro oficial, y las capacidades de herramientas e imágenes se muestran aparte.
- **Google · Gemini (Gemini CLI, sujeto a elegibilidad)**: Google puede rechazar el cliente para cuentas personales y solicitar la migración a Antigravity. Ese acceso personal no funciona con esta integración; Para esa conexión, selecciona el ejecutable `agy` descrito arriba. Para cuentas con acceso compatible, pulsa **Iniciar sesión con Google** y completa el flujo oficial en el navegador externo. Gemini CLI está incluido como dependencia local. Cada perfil usa su propio `GEMINI_CLI_HOME`; las credenciales las gestiona el CLI. Para cuentas de organización que lo requieran, despliega **Cuenta de empresa · Proyecto de Google Cloud** y guarda su ID antes de conectar. El catálogo se consulta al CLI autenticado. Las credenciales guardadas por sí solas no marcan la cuenta como conectada; un rechazo por cliente retirado se conserva al actualizar el estado y reiniciar la app.

OpenRouter transmite las respuestas en tiempo real. Los errores recibidos durante la transmisión conservan su código (por ejemplo 429, 502 o 503), sin mostrar cuerpos de error que puedan contener datos privados. Las respuestas parciales se conservan en el contexto al reintentar y nunca se ejecutan llamadas a herramientas incompletas. Los modelos con herramientas pueden listar/leer archivos del proyecto y también acceder a rutas externas (absolutas o con `../`) solicitando permiso dentro del chat. **Permitir una vez** autoriza esa lectura; **Permitir carpeta en este chat** recuerda el acceso de lectura a esa carpeta y sus subcarpetas hasta detener el chat o reiniciar la app. Los enlaces simbólicos se comprueban por su destino real y se mantiene la exclusión de archivos sensibles. La escritura directa sigue limitada al proyecto y requiere aprobación, igual que los comandos. Los comandos aprobados se ejecutan **sin sandbox**, se interrumpen junto con su grupo de procesos y tienen un tiempo máximo de 60 segundos. Los modelos sin herramientas se mantienen como conversación. Gemini se integra por ACP, con respuestas, cambios de modelo, permisos y restauración de sesiones propios del CLI; se mantiene su política de permisos predeterminada. Estas integraciones no exponen todavía el MCP de coordinación/navegador de Agent Desk.

El consumo de OpenRouter muestra tokens y coste comunicado por la API; si se calcula con los precios del catálogo se marca como aproximado. El crédito mostrado es el restante **de la clave**, cuando OpenRouter lo devuelve, no una cuota de suscripción. Una respuesta interrumpida puede tener costes que aún no se hayan comunicado. Gemini no muestra porcentajes de cuota inventados si ACP no informa de ellos. Las suscripciones de Claude/Codex conservan sus indicadores actuales.

OpenRouter permite a los modelos con visión leer imágenes locales mediante `read_image`, con el mismo permiso si están fuera del proyecto. Los modelos de texto no reciben imágenes como si fueran texto. OpenRouter envía imágenes adjuntas a modelos con visión y PDF con el extractor `cloudflare-ai` (sin recurrir automáticamente a OCR de pago); texto y CSV se incluyen como contenido. Otros archivos binarios se ofrecen mediante su ruta local a modelos con herramientas para procesarlos con aprobación. El historial de OpenRouter se conserva como conversación; después de reabrirlo, los adjuntos antiguos deben adjuntarse otra vez si el modelo necesita su contenido original. Gemini conserva el contexto de su sesión oficial. Los límites reales de cada proveedor siguen vigentes.

Referencias: [catálogo de OpenRouter](https://openrouter.ai/docs/api/api-reference/models/get-models), [PDF de OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/pdfs), [autenticación de Gemini](https://geminicli.com/docs/get-started/authentication/), [integración ACP](https://geminicli.com/docs/cli/acp-mode/), [migración oficial a Antigravity](https://antigravity.google/docs/cli/gcli-migration/), [acceso con Google en Antigravity](https://antigravity.google/docs/cli/install/).

Pruebas locales sin cuentas reales ni cargos: `npx tsx --test tests/providers.test.ts`, `npm run build && node scripts/providers-check.mjs`. `node scripts/gemini-protocol-check.mjs` comprueba el protocolo y las capacidades del CLI oficial instalado sin iniciar sesión ni ejecutar inferencia.

## Cuentas en Ajustes

**Añadir cuenta** permite elegir Claude, ChatGPT · Codex, OpenRouter · API o Google · Gemini y un nombre opcional. Crea un perfil local independiente; después pulsa **Iniciar sesión** en su tarjeta para completar el flujo oficial. Las cuentas adicionales aparecen en el selector de todos los proyectos y se guardan al reiniciar. Los perfiles se crean solo al pulsar **Añadir cuenta**: `profiles/claude-1/`, `profiles/codex/` y, para cuentas posteriores, `profiles/claude-2/`, `profiles/codex-2/`, etc. Las cuentas existentes mantienen sus identificadores y directorios. Cada cuenta mantiene sus conversaciones, configuración, procesos y acceso independientes; cerrar sesión detiene únicamente los agentes de ese perfil. Se admiten hasta 100 perfiles.

El selector muestra **nombre del perfil · correo · plan** cuando la herramienta oficial confirma esos datos (`subscriptionType` en Claude y `planType` en Codex). Se comprueban al abrir la aplicación y pueden actualizarse en Ajustes. Si el proveedor no devuelve el plan, aparece «Plan no disponible»; no se deduce del modelo. La identidad se conserva solo en memoria y no se leen archivos de credenciales.

Cada perfil muestra su estado comprobado con la herramienta oficial y el correo cuando está disponible. Un error de consulta se presenta como **Estado sin verificar**, no como una desconexión. **Iniciar sesión**, **Cambiar cuenta**, **Cerrar sesión**, **Cancelar acceso** y actualizar estado están en una tarjeta por perfil. Cerrar Ajustes no cancela el acceso pendiente; puedes volver al panel.

Las consultas de consumo de Codex no modifican la autenticación ni borran errores de verificación. Al cambiar de pestaña o cuenta se consulta como máximo una vez por minuto por perfil, también si la red falla; un cambio de autenticación permite una nueva consulta. Si `account/read` falla por conexión, el chat no se presenta como listo ni solicita iniciar sesión de nuevo: conserva el borrador y permite reintentar. Los errores de conexión indican revisar red, proxy o VPN. Tras compilar, `node scripts/account-navigation-check.mjs` comprueba navegación, borradores, límites de consulta y recuperación con procesos simulados.

Antes de cambiar la autenticación se confirma la parada de todas las sesiones abiertas con ese perfil, en todos sus proyectos. Las otras cuentas continúan funcionando. La operación se bloquea si hay un arranque pendiente o no se confirma la salida de un proceso. Los historiales, referencias y proyectos se conservan; después del acceso, envía el mensaje para que el agente arranque con la cuenta actualizada.

**Eliminar cuenta** permite quitar un perfil local desde Ajustes, incluso si falla su autenticación o falta el ejecutable. Tras confirmar, cancela el acceso pendiente y detiene sus agentes; si no se confirma su parada, no elimina el perfil. La cuenta y sus conversaciones desaparecen de la aplicación. Su carpeta local se envía a la Papelera con una copia de las conversaciones en `agent-desk-removed-account.json`. No elimina la cuenta del proveedor ni los proyectos, sus archivos o las demás cuentas. Los identificadores eliminados no se reutilizan: una cuenta nueva no hereda el directorio ni el acceso del perfil anterior. No supone un borrado seguro de credenciales ni revoca el acceso remoto del proveedor.

Verificación: `tests/remove-account.test.ts` comprueba aislamiento, confirmación, fallos, cancelación y creación de perfiles nuevos. Tras compilar, `node scripts/remove-account-check.mjs` prueba el recorrido completo en Electron con cuentas temporales y una Papelera de prueba, sin utilizar cuentas reales.

Claude ejecuta `auth status --json`, `auth login --claudeai` y `auth logout` con el `CLAUDE_CONFIG_DIR` del perfil. Codex usa `account/read`, `account/login/start`, `account/login/cancel` y `account/logout` mediante un app-server temporal con su `CODEX_HOME`. Estos procesos se ejecutan en la carpeta privada del perfil, sin necesitar un proyecto. La app no lee archivos de credenciales, no copia tokens y no guarda el estado de autenticación en `state.json`.

El arranque y la comprobación de acceso de Claude admiten hasta 60 segundos: en macOS se ha observado un arranque en frío de unos 41 segundos. Ajustes distingue «Iniciando Claude Code…», el acceso oficial y «Validando cuenta…». Cancelar detiene el acceso sin iniciar otra comprobación. Una cuenta solo se muestra conectada tras la respuesta oficial de `auth status`. `node scripts/claude-login-check.mjs` verifica este recorrido con procesos simulados en perfiles temporales.

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

`codex app-server` con `CODEX_HOME` propio, acceso con ChatGPT, aprobaciones por turno y preguntas. Codex también se configura desde la interfaz: chips de **modelo** (catálogo real y paginado de `model/list` del servidor), **permisos** (Solo lectura, Preguntar antes de actuar, Trabajar en el proyecto y Acceso total) y **esfuerzo de razonamiento** (los niveles que admite cada modelo). Modelo, aprobación, sandbox y esfuerzo se envían en cada turno; las instrucciones se aplican al reabrir el hilo. El modo de permisos combina acceso y política de aprobación, con una descripción visible. Cambiarlo durante una tarea afecta al siguiente mensaje; una acción pendiente se autoriza desde su solicitud.

Abre **Modelo de Codex** bajo el cuadro de escritura y selecciona el modelo. El esfuerzo ofrece solo niveles compatibles, también para el modelo predeterminado. **Actualizar modelos** vuelve a consultar el catálogo y muestra cualquier error en lugar de ocultarlo. La elección se guarda por sesión y se restaura al reiniciar. Volver a **Por defecto** envía el modelo y esfuerzo predeterminados comunicados por el servidor, para no heredar por accidente el modelo anterior del hilo. Consultar el catálogo no sustituye la autenticación: enviar tareas sigue requiriendo ChatGPT válido.

## Diseño

Interfaz plana y mínima: fondo liso, superficies del mismo tono, separadores finos y colores discretos. Se han retirado los encabezados decorativos y la leyenda bajo el compositor. Las pestañas, cuentas, estados y acciones conservan sus etiquetas accesibles; los proyectos usan formas geométricas de color para identificarlos también con la barra plegada. Sigue automáticamente el modo claro u oscuro del sistema (`prefers-color-scheme`), incluida la terminal integrada. No usa una librería de chat: la vista es React propio sobre el estado que emite el proceso principal, lo que permite dibujar herramientas anidadas, permisos, preguntas y notas del sistema exactamente como los produce cada agente.

Identidad propia, derivada de las marcas geométricas de los proyectos: un único acento pervinca (enlaces, pestaña activa, botón de enviar, foco, permisos y lo que espera tu respuesta), código en línea en salvia, resaltado de sintaxis con los pastel apagados de las marcas y, como logotipo y marca de agua, cuatro de esas formas (círculo, rombo, triángulo y cuadrado). El ámbar queda solo para avisos; verde y rojo, para diferencias. El cuadro de mensaje es una sola pieza plana: la barra de Git hace de cabecera (con la marca del proyecto), el texto va en un marco de línea fina, los controles son cuadrados redondeados y monocromos (gris apagado en reposo; en blanco intenso, o tinta en modo claro, cuando están activos, como «Omitir permisos» o el modelo Auto) y enviar es ↵ sobre un cuadrado pervinca. El contorno es gris apagado y se enciende en blanco intenso mientras escribes; los modos de permisos no lo colorean. Los tokens están al principio de la sección «Chat v2» de `src/style.css`.

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

`⌘K` buscar · `⌘N` nueva sesión · `⌘,` Ajustes · `⌘⇧A` centro de atención · `↵` enviar · `⇧↵` nueva línea · `/` comandos · `@` archivos del proyecto · `↑/↓` mensajes anteriores · `⌘V` pegar capturas · `1/2/3` responder permisos · `⇧⇥` modo de permisos · `Esc` interrumpir o cerrar paneles.

## Arquitectura

- `electron/main.ts`: ventana, origen IPC, diálogos nativos.
- `electron/manager.ts`: proyectos, sesiones, procesos concurrentes, comandos locales y configuración en caliente.
- `electron/coordination.ts` y `electron/coordination-bridge.ts`: reservas atómicas de rutas y herramienta MCP compartida, con acceso local limitado por sesión.
- `electron/browser.ts`: pestañas nativas persistentes, almacenamiento aislado por proyecto y controles para los agentes. `src/browser-panel.tsx` coloca el navegador dentro del panel lateral.
- `electron/project-terminals.ts`: pseudoterminal de shell por proyecto.
- `electron/project-files.ts`: rutas mencionadas en el chat (siempre dentro del proyecto, enlaces simbólicos resueltos) y lista de archivos para `@`.
- `electron/claude.ts`: ejecución del Agent SDK: cola de mensajes, `canUseTool`, interrupción, modelo/permisos/esfuerzo en vivo, uso de contexto, MCP.
- `electron/claude-events.ts`: reductor puro que convierte los mensajes del SDK (streaming, herramientas, resultados, sistema, límites) en el estado de la sesión.
- `electron/core.ts`: esquemas IPC y de configuración, traducción de la configuración a opciones del SDK, respuestas de permisos, aislamiento de entorno.
- `electron/rpc.ts`, `electron/codex-events.ts`: Codex app-server.
- `electron/store.ts`, `electron/processes.ts`, `electron/preload.ts`: persistencia validada, cierre de procesos y puente mínimo.
- `src/main.tsx` (aplicación), `src/chat.tsx` (mensajes, herramientas, permisos, preguntas, compositor, comandos), `src/accounts-settings.tsx` (cuentas), `src/markdown.tsx` (render seguro sin HTML), `src/highlight.tsx` (resaltado ligero), `src/activity.ts` (pasos, resúmenes, diferencias y archivos cambiados), `src/terminal.tsx` (xterm), `src/style.css`.

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

El **globo de la cabecera** abre el navegador Chromium integrado. Las cookies persistentes y el almacenamiento local se conservan entre reinicios, aislados por proyecto (las caducidades y cookies de sesión siguen las reglas de cada web). Al quitar un proyecto se limpia su almacenamiento del navegador. Sus pestañas son independientes del chat seleccionado: puedes mantener varios proyectos y puertos abiertos, cambiar de proyecto y volver a la misma página. Admite webs HTTP(S), atrás, adelante, recarga y zoom por pestaña. Los enlaces HTTP(S) y ventanas emergentes aparecen como pestañas internas conservando la conexión con la ventana de origen, los formularios POST, `postMessage` y `window.close()`. Se permite que una ventana empiece en `about:blank` y navegue después, con las mismas restricciones de navegación y aislamiento.

La opción **Abrir fuera** del menú **…** abre la página en Chrome en macOS, o en el navegador predeterminado si Chrome no está disponible. En rutas de autenticación se abre la web de origen para empezar un acceso nuevo; no se transfieren cookies ni códigos OAuth al navegador externo. Las páginas de autenticación muestran un acceso directo a esta opción. Google puede seguir bloqueando el acceso dentro de Electron; ese acceso debe completarse en el navegador externo. Las rutas de autorización guardadas se restauran desde la web de origen para no reutilizar un código caducado.

Ocultar el panel conserva las páginas. La `×` de una pestaña la cierra; **… → Suspender** suspende su página y libera memoria sin detener el servidor. Al reanudar se vuelve a cargar la URL: el estado de formularios sin guardar puede perderse. Se admiten hasta 60 pestañas guardadas y seis páginas cargadas simultáneamente; al alcanzar ese límite, suspende una página para cargar otra. Las páginas ocultas limitan su actividad en segundo plano. Al reiniciar se restauran direcciones, títulos, proyectos y zoom como pestañas suspendidas, sin cargar todas las webs.

El almacenamiento web se comparte entre pestañas del mismo proyecto y se conserva entre reinicios, sin importar credenciales externas. Cerrar un chat conserva las pestañas del navegador; quitar el proyecto las elimina y limpia su almacenamiento. Los servidores siguen el ciclo de vida del proceso que los inició; conservar una pestaña no mantiene vivo un servidor cuyo proceso se cierra.

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

## Trabajo simultáneo, worktrees y coordinación

Varios agentes pueden trabajar a la vez en un proyecto (hasta cinco abiertos), con conversaciones y procesos independientes.

### Aislamiento real con worktrees (Claude)

Cada chat de Claude puede **aislarse en un git worktree** con su propia rama `agent-desk/<título>-<id>`. La opción **Aislar en worktree** aparece sobre la conversación antes de abrir el agente y viene **activada por defecto cuando ya hay otro agente vivo en el mismo proyecto** (el texto indica cuántos). Al abrir el agente:

- Se crea el worktree desde el `HEAD` local de la rama actual (semántica `baseRef: 'head'`: commits sin publicar incluidos; los cambios sin commit de la copia principal no). La carpeta vive en los datos de la app (`<datos>/worktrees/<repo>-<hash>/`), nunca dentro del proyecto. Si el proyecto es una subcarpeta del repositorio, el agente trabaja en esa misma subcarpeta del worktree.
- Se enlazan las carpetas pesadas sin seguimiento de `worktree.symlinkDirectories` (ajuste oficial de Claude Code en `.claude/settings*.json`; por defecto `node_modules`) y se excluyen en `.git/info/exclude` para que no aparezcan como archivos nuevos.
- El SDK arranca con `cwd` en el worktree, `projectConfigRoot` en la copia principal (ajustes, hooks, `.mcp.json` y `.claude` de confianza) y `settings.worktree` (`symlinkDirectories`, `baseRef: 'head'`) para que `EnterWorktree` o los subagentes aislados del propio agente se comporten igual.
- Un chat aislado **no usa reservas**: no recibe el hook `PreToolUse` ni la herramienta `coordinate` (sigue teniendo `browser`) y no aparece en el estado de coordinación de los demás.

La rama del worktree se muestra sobre la conversación, en la tarjeta del Multichat y en la barra de Git (**Worktree · rama**). Con un chat aislado seleccionado, la barra de Git muestra el estado de su worktree (archivos sin commit, commits por fusionar y commits nuevos en la base) y estas acciones:

- **Fusionar en <rama base>**: hace commit de lo pendiente en el worktree, comprueba conflictos con `git merge-tree` **sin tocar la copia principal** y, si no los hay, fusiona (`--no-ff`). Requiere que la copia principal esté en la rama base, sin cambios sin commit y sin agentes trabajando directamente en ella. Con conflictos, muestra la lista y no cambia nada.
- **Traer cambios de <rama base>**: fusiona la base en el worktree; los conflictos quedan allí para que el agente los resuelva y haga commit.
- **Descartar worktree**: tras confirmar (indica archivos sin commit y commits sin fusionar), detiene el agente y borra la carpeta y la rama.

Quitar un proyecto de la app no borra sus worktrees ni sus ramas: descártalos antes o elimínalos con `git worktree remove`. Si no se puede aislar un chat que lo tenía activado por defecto (carpeta sin Git, repositorio sin commits o `HEAD` separado), el chat avisa y trabaja en la carpeta compartida con reservas; si lo activaste tú, el arranque falla con el motivo.

Los hooks `WorktreeCreate`/`WorktreeRemove` y la opción `--worktree` del CLI no encajan aquí: sustituyen la creación cuando el agente ya está en marcha (`EnterWorktree`) y el CLI decide nombre, ubicación y reanudación de sus worktrees. El `cwd` de un chat debe existir antes de lanzar el proceso y la app necesita fusionar y descartar de forma determinista, así que crea los worktrees con `git` y reutiliza los ajustes oficiales. Al reanudar, Claude Code encuentra la conversación aunque el `cwd` cambie a otro worktree del mismo repositorio.

### Duplicar chat y deshacer un turno

- **Duplicar chat** (sobre la conversación y en la tarjeta del Multichat) abre una pestaña nueva con el mismo historial para probar otro enfoque en paralelo. Usa `resume` + `forkSession: true` del SDK con un id nuevo (o `--fork-session` en la terminal oficial) en el primer arranque. La copia va a **otro worktree** que parte de los archivos actuales del original (si el original está aislado, antes se hace commit de lo pendiente en su rama) y se fusiona en la misma rama base. La copia empieza sin puntos de restauración.
- **Deshacer cambios de este turno** (icono en cada mensaje tuyo de Claude): consulta primero con `Query.rewindFiles(id, { dryRun: true })` cuántos archivos cambiarían y, tras confirmar, restaura los archivos al estado anterior a ese mensaje (también deshace los turnos posteriores). Cada mensaje enviado lleva su propio `uuid`, que el CLI usa como punto de restauración (`enableFileCheckpointing` está activo por defecto en la configuración). Solo cubre las ediciones de las herramientas de Claude, no comandos de terminal, y no modifica la conversación.

### Carpeta compartida y coordinación (Codex, otros proveedores y Claude sin aislar)

Los agentes que comparten la carpeta del proyecto (Codex, Claude con **Aislar en worktree** desactivado o un chat que ya trabajó en la carpeta compartida) reciben la herramienta MCP local `agent_desk.coordinate`, tanto en hilos nuevos como al reanudar. La app comparte las tareas actuales y las rutas reservadas, no el historial completo de las otras conversaciones. Los datos permanecen en memoria del proceso principal y se envían al proveedor correspondiente cuando el agente consulta la herramienta.

- `status`: consulta agentes, tareas y reservas del proyecto.
- `claim`: reserva atómicamente archivos o directorios. Dos agentes pueden reservar rutas distintas; si una ruta coincide o está dentro de un directorio reservado, se rechaza todo el lote. Se resuelven enlaces simbólicos y se rechazan rutas fuera del proyecto.
- `release`: libera las reservas propias. La app también las libera tras confirmar que el proceso ha terminado. No expiran mientras el agente sigue abierto.

Las instrucciones piden consultar tareas, reservar antes de escribir, volver a leer los archivos tras obtener la reserva y liberar después de terminar los comandos. Un hook de Claude añade una comprobación automática para Write/Edit/MultiEdit/NotebookEdit en la carpeta compartida. El coordinador no modifica archivos del proyecto ni la configuración global. Solo las herramientas internas validadas `coordinate` y `browser` reciben aprobación automática; las aprobaciones de comandos, ediciones y otros MCP no cambian.

**Límite real:** en la carpeta compartida, las reservas no son bloqueos del sistema de archivos. Un comando de shell, herramienta externa, agente que ignore las instrucciones, terminal manual o alias por enlace duro puede saltárselas. Para trabajo en paralelo seguro con Claude usa los worktrees. Codex y los demás proveedores siguen compartiendo carpeta. El indicador del chat permite consultar agentes y reservas reales.

## Panel derecho

La terminal se abre en un panel inferior que ocupa el ancho de chat y navegador. El botón **A la derecha** la coloca junto al chat y **Abajo** la devuelve al panel inferior, conservando el proceso, el buffer y lo que estés escribiendo. La posición y el reparto de ancho se guardan localmente; arrastra el separador lateral, usa sus flechas o haz doble clic para centrarlo. Los márgenes interiores dejan espacio alrededor del texto y el cursor. Si Git o el navegador también están abiertos, se apilan bajo el chat mientras la terminal ocupa la derecha. Terminal está arriba a la derecha, a la izquierda del navegador. Git tiene una barra compacta sobre el campo de mensaje con el nombre del proyecto, la rama y las líneas añadidas/eliminadas en cambios preparados y sin preparar (excluye archivos sin seguimiento y binarios). Pulsar el proyecto o los contadores abre/cierra los cambios actuales a la derecha. Se actualizan al cambiar de proyecto, cambiar el estado del agente, alternar la terminal, abrir el panel o volver a la ventana. Git y Navegador (globo) comparten el panel derecho. El separador entre chat y panel se puede arrastrar: el chat baja hasta 220 px y el panel ocupa el resto. La proporción se guarda localmente; un doble clic centra el reparto. Con el separador enfocado, las flechas ajustan el ancho y Inicio/Fin lo llevan a los extremos. El navegador nativo se adapta al tamaño y se oculta momentáneamente durante el arrastre para no interceptar el puntero. Con Git y navegador activos, el lateral se divide en zonas apiladas. Terminal es un shell real del proyecto; ocultarlo conserva el proceso y el buffer, y salir de la app lo cierra. Las sesiones antiguas de Claude en modo terminal oficial se muestran también abajo. La pantalla de chat vacía muestra una marca de agua, sin sugerencias.

## Verificación de esta revisión

- `npm test`: IPC, cuentas, permisos, persistencia, procesos, pestañas, reservas concurrentes, rechazo de rutas, autorización restringida del coordinador y worktrees (`tests/worktrees.test.ts`: creación, subcarpetas, fusión, conflictos, duplicado, descarte, aislamiento por defecto y opciones de fork).
- `npm run build && node scripts/concurrency-check.mjs`: tres procesos oficiales a la vez, MCP conectado en Claude/Codex, llamadas reales a la herramienta, conflicto de reservas y recuperación de hilo vacío. No realiza llamadas de modelo ni toca proyectos existentes.
- `node scripts/worktree-check.mjs`: worktrees en un repositorio temporal sin llamadas de modelo: aislamiento por defecto con otro agente vivo, enlace de `node_modules`, fusión con commit automático, conflicto detectado sin tocar la copia principal, conflicto llevado al worktree y resuelto, duplicado en otro worktree y descarte de carpetas y ramas. Si encuentra Claude Code, abre un chat aislado de verdad (solo inicialización) y comprueba el MCP y la ausencia de reservas compartidas.
- `npm run build && node scripts/worktree-ui-check.mjs`: interfaz con datos simulados: rama sobre el chat, panel de worktree en Git, conflictos, confirmación de descarte, deshacer un turno, duplicar chat, interruptor por defecto y rama en el Multichat. Capturas en `artifacts/worktree-*`.
- `node scripts/workspace-check.mjs`: comprobación visual, shell y cwd reales, panel dividido y compacto, primer envío de Codex sin autenticar conservando el borrador.
- `AGENT_DESK_PROFILES_DIR="$HOME/Library/Application Support/Agent Desk" node scripts/coordination-live-check.mjs`: **comprobada en esta revisión**, prueba optativa con las suscripciones autenticadas. Envía tareas mínimas simultáneas de Claude/Codex en una carpeta temporal para comprobar herramientas, rechazo de una reserva y reanudación de un hilo persistido; no crea ni edita archivos en esa carpeta.

Esta revisión cambia el protocolo interno (IPC 35 con worktrees). En una instancia de desarrollo anterior, cierra las pestañas con procesos abiertos y pulsa **Actualizar aplicación**, o sal con `⌘Q` y ejecuta `npm run dev`. No se reinician agentes activos automáticamente.

Revisión visual minimalista: `npm run build && node scripts/browser-check.mjs` verifica arrastre, teclado, ancho mínimo, persistencia de la proporción, iconos estables, ausencia de leyendas y adaptación a 900 px, con una web local real. Capturas en `artifacts/36-*` y `artifacts/37-*`.

Revisión de cuentas ampliables: `node scripts/profiles-check.mjs` (tras `npm run build`) crea cuentas adicionales desde Ajustes, consulta los binarios oficiales con perfiles vacíos, abre un proceso Claude y otro Codex en esos perfiles, verifica cierre de sesión limitado al perfil, persistencia y rechazo de identificadores no registrados. También comprueba los controles solo con iconos (la selección actual aparece al pasar el ratón) y las barras de navegador/pestañas alineadas a 38 px. No envía tareas de modelo. Capturas en `artifacts/38-*` y `artifacts/39-*`.

Orden de proyectos: arrastra una fila de la barra lateral sobre otra para cambiar su posición, también con la barra plegada. El orden se guarda con los datos de la app y se conserva al reiniciar. Reordenar no cambia el proyecto seleccionado, las rutas ni los chats en marcha. Con una fila enfocada, **Alt + ↑/↓** la mueve una posición. Requiere actualizar o reiniciar las instancias anteriores (IPC 32). `tests/project-order.test.ts` comprueba persistencia, validación y conservación de sesiones; `scripts/multichat-check.mjs` verifica arrastre con barra desplegada y plegada.

Renombrado directo: doble clic sobre un proyecto o una pestaña de chat permite editar su nombre en el mismo sitio. Enter o salir del campo guarda; Esc cancela y un nombre vacío conserva el anterior. El nombre de proyecto es una etiqueta local: no renombra la carpeta ni altera su ruta o archivos. Doble clic en un proyecto plegado expande la barra para editarlo. `node scripts/navigation-check.mjs` verifica edición, cancelación, persistencia, ruta intacta, buscador y terminal inferior con su PTY real.

## Uso de suscripción y adjuntos

La barra de Git sobre el compositor permite abrir **Gestionar ramas y Git**: muestra la rama, archivos modificados/nuevos, conflictos, líneas y commits por subir o bajar. El panel permite crear/cambiar ramas locales, preparar todos los cambios o retirarlos de preparación, crear un commit, consultar los remotos (`fetch`), bajar con avance rápido (`pull --ff-only`) y subir o publicar la rama actual. Incluye los últimos cinco commits. Los contadores remotos corresponden a las referencias locales: pulsa **Consultar remoto** para actualizarlas. El estado local se refresca cada diez segundos mientras la ventana es visible, además de los cambios de proyecto, foco y agente. Las carpetas sin Git muestran **Sin repositorio Git**.

Las acciones se aplican a todo el repositorio, también si el proyecto apunta a una subcarpeta. Cambiar/crear rama y bajar cambios requieren un árbol limpio. Los conflictos bloquean commit y push; los agentes abiertos en la copia principal del repositorio bloquean las operaciones que modifican Git (los chats aislados en worktrees no). Con un chat aislado seleccionado, la barra muestra su worktree y las acciones de fusionar, traer cambios y descartar. No hay push forzado, borrado de ramas ni descarte de archivos. Un pull divergente muestra el error y requiere resolverlo desde la terminal. La autenticación del remoto usa la configuración local de Git; si necesita una interacción que la app no puede completar, muestra el error. Una operación pendiente de Git bloquea el reinicio y se espera al cerrar.

También puedes **arrastrar imágenes a cualquier parte del chat**. Se ilumina el destino, se añaden miniaturas al borrador y no se envía el mensaje automáticamente. Admite PNG, JPEG, GIF y WebP sin límites propios de tamaño, dimensiones o cantidad. Se valida el contenido y su decodificación en el proceso principal; el arrastre transmite bytes, no rutas arbitrarias. Los lotes inválidos no se adjuntan parcialmente. Las miniaturas de los mensajes enviados se conservan al reiniciar.

`tests/git.test.ts` comprueba repositorios reales temporales, ramas sin commits, archivos con espacios/saltos de línea, preparación, commits, ramas, conflictos, HEAD separado y sincronización contra un remoto local, incluida divergencia sin forzar. `node scripts/git-images-check.mjs` (tras compilar) recorre las acciones desde Electron y comprueba arrastre de imágenes grandes, formatos, borradores por chat y diseño compacto, sin cuentas reales ni llamadas de modelo.

El selector está debajo del compositor, a la izquierda del modelo. Muestra el nombre de la cuenta y un único **porcentaje restante**: la ventana de **5 horas para Claude** o la **semanal para ChatGPT/Codex** (100 menos el porcentaje consumido). Los datos ausentes o caducados se muestran como «—». No suma ventanas ni estima consumo a partir de tokens, coste o contexto. Codex usa `account/rateLimits/read` y sus notificaciones oficiales; prioriza el bucket `codex`. Claude usa las ventanas generales de la consulta estructurada `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` del SDK instalado, únicamente cuando ya hay un chat de esa cuenta abierto. Esta función de Claude es experimental: versiones que no la incluyan muestran una explicación. No se leen ni extraen credenciales. Las ventanas específicas de un modelo y el uso extra de pago no se mezclan con las cuotas generales.

Se consulta al seleccionar cuenta, al cambiar el estado del agente, al volver a la ventana y cada minuto mientras sea visible. La vigencia de la lectura se comprueba cada 10 segundos. Cada porcentaje deja de mostrarse tras su propio reinicio, o con lecturas de más de 3 minutos, hasta recibir datos nuevos. Ausencia de datos muestra «—», nunca 0% inventado. No se consultan saldos mediante llamadas de inferencia.

El **clip** del compositor abre un diálogo nativo para adjuntar archivos: PDF, CSV/TSV, Word, Excel, PowerPoint, documentos OpenDocument, texto, Markdown, JSON, código, ZIP e imágenes. El filtro «Todos los archivos» permite otros formatos. También se pueden arrastrar o pegar archivos. Agent Desk no impone límites de tamaño, dimensiones, cantidad ni tamaño total de los adjuntos. Los límites técnicos del servicio elegido (Codex o Claude) y de los recursos del equipo siguen aplicándose. Los documentos se muestran con nombre, extensión y tamaño. Se validan tipo real y decodificación en el proceso principal, se muestran miniaturas y se pueden quitar antes de enviar. Se admite enviar solo adjuntos. Los borradores de adjuntos se conservan por chat mientras la app está abierta, también si el envío falla por falta de autenticación. Las referencias IPC son identificadores opacos ligados a la sesión, sin acceso del renderer a rutas arbitrarias. Los originales se copian a `attachments/` dentro de los datos privados de Agent Desk; no se modifican los archivos elegidos ni los proyectos. Los adjuntos no enviados se limpian al salir; los enviados se conservan para que Codex pueda reanudar referencias locales. Las miniaturas de mensajes enviados se guardan con la conversación.

Las imágenes se envían mediante bloques base64 del flujo oficial de Claude y `localImage` de Codex app-server. Los demás archivos se copian conservando nombre y extensión en una carpeta privada por adjunto; ambos agentes reciben referencias locales para leerlos con sus herramientas. La interpretación de formatos binarios (PDF, Office, ZIP, etc.) depende de los lectores y permisos disponibles en el agente; adjuntar no instala conversores ni garantiza compatibilidad nativa con todos los formatos. Se comprueba la integridad de la copia antes del envío y se elimina al borrar la conversación. No cambia el método de autenticación ni añade un proveedor de API. Referencias: [Codex app-server](https://learn.chatgpt.com/docs/app-server) y [entrada de imágenes en Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). La consulta experimental de uso se ha validado contra los tipos del SDK local instalado.

Verificación de archivos: `node scripts/attachments-check.mjs` (tras compilar) comprueba en Electron el selector PDF, arrastre CSV/Office, pegado de archivos, lotes de más de diez adjuntos, borradores por chat y diseño compacto, sin llamadas de inferencia.

Verificación: `npm test` cubre unidades de cuota, reinicios/caducidad, selección de ventanas, aislamiento de adjuntos y formatos de envío. `node scripts/usage-images-check.mjs` usa Electron, diálogos y procesos oficiales reales con perfiles vacíos; comprueba miniaturas, eliminación, cambio de chat, consulta de uso sin autenticación y conservación del adjunto tras rechazo de Codex sin sesión. La recepción e interpretación de la imagen por un modelo y los porcentajes de una cuenta autenticada necesitan una comprobación con sesión iniciada. No se han simulado respuestas ni cuotas dentro de la aplicación.


## Ahorro de tokens por cuenta

En **Ajustes → Cuentas**, cada perfil guarda un nivel independiente: Desactivado, Suave (respuesta breve), Equilibrado (menos repetición y esfuerzo hasta medio) e Intenso (una frase o 1–3 viñetas, unas 60 palabras como máximo orientativo, y esfuerzo bajo en peticiones sencillas). Las peticiones detectadas como complejas, planes, imágenes y continuaciones conservan el esfuerzo. Se respetan los niveles que declara el catálogo y cualquier esfuerzo manual ya inferior. Estas instrucciones son preferencias, sin truncar respuestas ni omitir verificaciones o permisos.

**Modelo automático** es independiente del nivel. Una heurística local, sin otra llamada de inferencia, reconoce peticiones sencillas, generales y complejas y elige una familia del catálogo disponible. Una continuación breve conserva el modelo anterior; los modelos desconocidos o la falta de alternativas conservan el manual. La clasificación no entiende todo el proyecto ni garantiza acertar. El modelo manual permanece guardado; se recupera al desactivar Auto. El selector de modelo del compositor incluye Auto; elegir un modelo manual desactiva Auto. El icono de hoja permite cambiar el ahorro de la cuenta. Ambos controles están en la fila inferior del compositor, sin anotaciones; sus tooltips muestran la selección actual.

Claude recibe la preferencia mediante `UserPromptSubmit.additionalContext` y cambia modelo/esfuerzo con los controles del SDK antes del envío, cuando está listo. Las peticiones en cola conservan los controles del proceso en curso. Codex recibe la política junto a las instrucciones del hilo (se reanuda al cambiar el nivel) y modelo/esfuerzo mediante `turn/start`. No modifica permisos, autenticación ni el terminal oficial. No instala skills ni modifica instrucciones de los proyectos. Cambiar de modelo puede afectar a la caché; las cuotas de suscripción no equivalen directamente a tokens ahorrados y no se promete un porcentaje de reducción.

Verificación: `npm test` incluye persistencia, validación IPC, clasificación y llamadas de Manager con transportes de prueba para ambos proveedores, restauración manual, cola Claude y permisos Codex. `node scripts/optimization-check.mjs` comprueba los controles reales en Electron, cambios seguidos, aislamiento por cuenta, reinicio y desactivación con perfiles temporales. Estas pruebas no consumen inferencia ni miden ahorro real. Capacidades contrastadas con [Codex app-server](https://learn.chatgpt.com/docs/app-server) y los tipos de Claude Agent SDK instalados.

## Chat compacto

El historial agrupa las intervenciones del asistente y sus herramientas entre mensajes del usuario o avisos del sistema. Los mensajes de progreso aparecen en el chat a medida que llegan, también mientras se está escribiendo cada mensaje, y permanecen visibles al terminar junto a la respuesta, sin cabeceras repetidas. Las herramientas y el razonamiento se conservan en el detalle desplegable. Durante una tarea, una línea fija sobre el compositor muestra la actividad más reciente y permite desplegar sus detalles técnicos. Al terminar se añade la respuesta; al abrir o parar un proceso se mantiene el historial anterior. Las solicitudes de permiso y los avisos de error siguen visibles. La agrupación es una proyección de la interfaz: no borra mensajes ni recorta el contexto que recibe el modelo, y por sí sola no ahorra tokens.

`tests/conversation.test.ts` cubre agrupación, preservación de mensajes, permisos, errores, arranques y paradas. `node scripts/compact-chat-check.mjs` (tras compilar) comprueba la posición fija, una sola línea, desplegables, respuesta y permisos en un navegador aislado con datos de prueba, sin llamadas a modelos. Capturas en `artifacts/chat-compacto-*.png`.

## Chat: lo mejor de Claude Code y Codex

Superficie mínima; el color solo aparece donde aporta significado (código, enlaces, diferencias, modos, avisos y el indicador de trabajo). Sin librerías nuevas: Markdown, resaltado de sintaxis y diferencias son módulos propios de pocas líneas (`src/markdown.tsx`, `src/highlight.tsx`, `src/activity.ts`).

- **Resumen del trabajo** al estilo de Claude Code y Codex: en lugar de «Ver pasos», una línea como «Leyó 3 archivos, ejecutó 2 comandos y editó 1 archivo · 1 min 23 s». Si hay muchas categorías se priorizan ediciones y comandos. Al desplegarla, cada paso ocupa una línea con icono, verbo, objetivo, líneas `+/−` y duración; al pulsarlo muestra el comando, la salida o la diferencia línea a línea con contexto plegado.
- **Archivos cambiados** al final de cada respuesta (tarjeta tipo Codex) con `+/−` por archivo; **Ver cambios** abre el panel de Git y cada ruta abre el archivo.
- **Markdown destacado**: código en línea con tinta propia, enlaces clicables (las webs abren una pestaña del navegador integrado; los enlaces a rutas del proyecto y las rutas de entregables escritas como código en línea muestran el archivo seleccionado en su carpeta de Finder), listas anidadas, tablas con alineación, avisos `> [!NOTE]`/`[!WARNING]`, y saltos de línea conservados como en la terminal. El texto nunca se interpreta como HTML.
- **Bloques de código** con resaltado ligero, copiar y, en `bash`/`sh`, **pegar en la terminal del proyecto**: el comando aparece listo y solo se ejecuta al pulsar ↵ (pegado entre corchetes).
- **Permisos**: tarjeta con la acción exacta (comando, diferencia o contenido), atajos **1** Permitir, **2** Permitir siempre (muestra la regla que se recordará, p. ej. `Bash(npm test:*)`), **3** Rechazar, y el plan de `ExitPlanMode` dentro de la tarjeta. Las preguntas aceptan números para elegir opción. Al llegar una solicitud el chat se desplaza hasta ella.
- **Progreso en vivo**: una forma geométrica animada (cuadrado → rombo → círculo) en el color de Agent Desk, la acción actual, tiempo transcurrido, pasos y `esc`. Tareas (`TodoWrite` en Claude y el plan de Codex) en una franja con barra de progreso que desaparece al completarse.
- **Compositor**: `@` abre la lista difusa de archivos del proyecto (Git o recorrido acotado), `↑/↓` recupera mensajes anteriores, `⌘V` pega capturas como adjuntos, y los modos no habituales se ven sin abrir menús, con su nombre en blanco intenso (Plan, Aceptar ediciones, Omitir permisos, Acceso total, esfuerzo elegido). El pie añade el contexto usado de Claude con un pequeño anillo.
- **Mensajes**: copiar respuesta o mensaje; botón de lectura en voz alta a la derecha de copiar respuesta, con voz del sistema en español y parada desde el mismo botón. Solo se lee una respuesta a la vez y se detiene al cambiar de chat. También se puede reutilizar un mensaje anterior en el compositor; modelo y duración del turno al pasar el ratón; mensajes largos plegados; botón para volver al final.
- **Pestañas**: punto de estado (trabajando, esperando respuesta, error o respuesta nueva sin leer) y aviso del sistema opcional cuando un chat en segundo plano termina o pide permiso (Ajustes → Interfaz).
- **Búsqueda ⌘K** también en el texto de las conversaciones (desde 3 caracteres), con un fragmento del mensaje encontrado. `/copy` copia la última respuesta. Al interrumpir con `Esc` queda una nota en el chat, sin un error ficticio.
- **Codex**: comandos, cambios, búsquedas web y MCP llegan estructurados (salida limitada a 30 000 caracteres finales, código de salida y duración); el razonamiento resumido y el plan del turno se muestran igual que en Claude.

Protocolo interno v20 (acciones `openPath` y `listFiles`): reinicia instancias anteriores. Verificación: `tests/chat-render.test.ts`, `tests/activity.test.ts`, `tests/agent-events.test.ts` y `tests/project-files.test.ts` (Markdown seguro, resaltado, resúmenes, diferencias, eventos de Claude/Codex, persistencia, rutas siempre dentro del proyecto). `npx vite build && node scripts/chat-design-check.mjs` recorre el chat con datos de prueba en claro y oscuro, y deja capturas en `artifacts/chat-v2-*.png`.

Los selectores del chat muestran solo las opciones; el de permisos de Codex incluye descripciones para distinguir el acceso de las aprobaciones. El selector de permisos ofrece **Omitir permisos** de Claude y **Acceso total** de Codex. En Claude, Omitir permisos utiliza `bypassPermissions` y se aplica en directo mediante el SDK: autoriza automáticamente las herramientas conforme a las reglas del proveedor. **Rechazar sin preguntar** conserva el modo restrictivo `dontAsk`; antes se llamaba «No preguntar», una etiqueta ambigua. Los permisos ya guardados no se elevan automáticamente. Los nuevos procesos Claude permiten cambiar de modo durante el chat, pero arrancan con el modo que se haya seleccionado; habilitar la posibilidad de cambiar no activa la omisión. Si el SDK rechaza un cambio, la app conserva el modo anterior. Las reglas explícitas de bloqueo, las políticas de la organización y las herramientas que necesitan una respuesta del usuario siguen vigentes, según la [documentación oficial de permisos](https://code.claude.com/docs/en/agent-sdk/permissions). Codex aplica el sandbox seleccionado en el siguiente turno mediante `sandboxPolicy`, sin reabrir el proceso. Ninguno se activa automáticamente al cambiar el ahorro.

Corrección de permisos: reinicia las instancias anteriores (IPC 19). `tests/permission-mode.test.ts` verifica cambio en directo, vuelta al modo manual, rechazo y persistencia. `scripts/prechat-project-check.mjs` comprueba desde Electron que seleccionar Omitir permisos envía `bypassPermissions` al SDK con la capacidad necesaria de arranque, sin ejecutar modelos.

## Firma del compositor

Debajo del campo de escritura aparece el modelo y `↑entrada ↓salida`, sin marco. Auto muestra el modelo elegido al enviar y vuelve a Auto al preparar otro mensaje. Durante una tarea conserva el modelo de esa tarea aunque cambie la selección manual para la siguiente. El tooltip muestra los tokens exactos acumulados de la conversación; `—` significa que aún no hay lectura confirmada. No son una estimación de cuota ni del texto del borrador.

Claude actualiza los totales con el resultado de cada respuesta, incluyendo entrada de caché. Codex consume `thread/tokenUsage/updated` y reemplaza los totales acumulados del hilo: no suma otra vez caché o razonamiento ni duplica notificaciones repetidas. Los datos confirmados se guardan con la sesión. Protocolo contrastado con los tipos generados por el binario instalado y la [documentación oficial de eventos](https://learn.chatgpt.com/docs/app-server#events). La firma no genera llamadas de inferencia ni sondeos adicionales.

## Ajustes de interfaz

**Ajustes → Interfaz** permite elegir el tamaño de los iconos de proyectos (14–28 px), la letra del chat (8–20 px), su color, el color del resto de iconos y el de los textos de la interfaz. El tamaño del icono ajusta también su botón y el ancho de la barra de proyectos plegada. **Auto** adapta el color al tema; **Restablecer** recupera los valores iniciales. La vista previa y el chat cambian al momento. Las preferencias se guardan localmente en esta instalación y se restauran al abrirla; no afectan a las páginas del navegador integrado.

**Tema**: Sistema, Claro u Oscuro. Lo aplica Electron (`nativeTheme`), así que cambian también la terminal, los controles nativos y las páginas del navegador integrado que respetan `prefers-color-scheme`. Se guarda en `appearance.json` junto a los datos y la ventana abre directamente en ese tema. **Restablecer** vuelve también a Sistema.

**Estilos (CSS)**: el bloque contiene el CSS completo del editor (se carga solo al abrir Ajustes). Cópialo, modifícalo y pégalo; **Guardar** (o ⌘S en el bloque) lo aplica al momento en toda la interfaz y se conserva al reiniciar. Se aplica por encima de los estilos originales: cambiar valores en el propio texto o añadir reglas con el mismo selector funciona, y pegar solo un fragmento no rompe el resto; borrar una regla no la quita. Un texto sin reglas CSS se rechaza. **Restablecer** (del bloque) vuelve a los estilos originales. Si un CSS deja la interfaz ilegible, **Ventana → Restablecer estilos de la interfaz** en la barra de menús de macOS siempre recupera los originales. **Temas**: el selector del bloque aplica al momento **Original**, los temas incluidos (los archivos de `themes/`, como **Terminal 8-bit**: verde fósforo, cursor ámbar, esquinas cuadradas y líneas de barrido; se cargan solo al elegirlos) o **tus temas**. **Guardar como tema…** guarda el CSS del bloque con un nombre (el mismo nombre lo sustituye); con uno de tus temas activo, **Guardar** lo actualiza, y **Eliminar** lo borra y vuelve a los estilos originales. Los temas se guardan localmente en esta instalación.

Verificación: `tests/appearance.test.ts`; `npx vite build && node scripts/interface-check.mjs` (tema, CSS completo, guardar, recarga, fragmento, texto inválido y restablecer desde el bloque y desde el menú) y, tras `npm run build`, `node scripts/theme-check.mjs` (tema real de Electron, validación, guardado y arranque en el tema elegido aunque el sistema use el contrario). Protocolo interno v21.

## Proxy corporativo

En **Ajustes → Red**, pulsa **Detectar proxy del sistema** o selecciona **Proxy manual** e introduce protocolo, servidor y puerto. La detección rellena el formulario: revisa los datos y guarda. Admite autenticación básica con usuario y contraseña; si la empresa exige otro método, consulta con TI la configuración compatible. No modifica el proxy del sistema operativo.

La contraseña se guarda cifrada con Electron `safeStorage` (Llavero en macOS), separada del estado de cuentas y conversaciones, en `network.json` dentro de los datos privados de la app. Nunca se devuelve al formulario. Un campo vacío conserva la contraseña guardada para el mismo servidor, puerto y usuario; cambiar cualquiera de ellos requiere introducirla de nuevo. También puedes eliminarla explícitamente. Si no hay almacenamiento seguro disponible, se rechaza su guardado.

OpenRouter también utiliza esta configuración: sus peticiones responden a la autenticación del proxy con las credenciales guardadas para ese servidor y puerto, sin enviarlas al proveedor. Los errores 407 remiten a **Ajustes → Red**. `node scripts/provider-proxy-check.mjs` reproduce el fallo de autenticación de `session.fetch` y comprueba el transporte corregido con un proxy local, reintentos acotados, aislamiento de credenciales y cancelación de respuestas en streaming.

**Probar ChatGPT / Claude** comprueba el túnel CONNECT y el certificado HTTPS del proveedor, sin iniciar sesión ni consumir modelos. Distingue autenticación rechazada (407), conexión inaccesible y fallo TLS. Una prueba correcta confirma la conexión, no la validez de la cuenta: después de guardar, actualiza su estado en **Cuentas**.

Si TI entrega un certificado CA corporativo, selecciona su archivo PEM público. Se valida antes de guardarlo y se utiliza al arrancar Claude y Codex, manteniendo la verificación TLS. El navegador integrado confía en los certificados del sistema; el navegador externo usado durante el acceso conserva su propia configuración. Se excluyen `localhost`, `127.0.0.1` y `::1` del proxy para las conexiones locales.

Guardar aplica los ajustes al navegador integrado y a los nuevos procesos de cuentas y agentes, incluidos los terminales oficiales de acceso. Los procesos que ya estaban abiertos conservan su entorno: detén y vuelve a abrir esos agentes para aplicar el cambio. El modo **Configuración del sistema / proveedor** restaura el comportamiento anterior de cada proveedor; si un CLI no detecta el proxy del sistema, usa la configuración manual. No se altera la configuración independiente de Git ni del shell del proyecto.

Verificación: `tests/proxy.test.ts` cubre cifrado, validación, aislamiento de credenciales, entorno de ambos proveedores y túneles locales con autenticación y certificados TLS. `npm run build && node scripts/proxy-check.mjs` comprueba formulario, error 407, persistencia tras reinicio y proxy del navegador con procesos y datos aislados. No usa cuentas reales. Esta revisión requiere reiniciar las instancias anteriores de la app (protocolo IPC 17).

Referencias: [red en Claude Code](https://code.claude.com/docs/en/network-config), [certificados CA de Codex](https://learn.chatgpt.com/docs/auth#custom-ca-bundles) y [almacenamiento seguro de Electron](https://www.electronjs.org/docs/latest/api/safe-storage).

## Quitar proyectos y preparar chats

Cada chat y subchat del árbol de proyectos muestra una papelera al pasar el ratón o acceder con el teclado. **Eliminar chat** pide confirmación, detiene su agente y borra definitivamente su historial, adjuntos, borradores y preferencias de ventana flotante de Agent Desk. Los demás chats se conservan; si se elimina un coordinador, sus subchats quedan independientes. Si falla la limpieza de adjuntos, se muestra el error y se conserva la conversación para reintentar.

**Quitar proyecto y chats** detiene los agentes y el terminal del proyecto, cancela las consultas de modelos y los arranques pendientes, y elimina las conversaciones del estado guardado de Agent Desk. También libera los buffers, borradores y miniaturas, elimina los originales de sus adjuntos y cierra sus pestañas de navegador, limpiando caché, cookies y almacenamiento de la partición de ese proyecto. Los proyectos restantes, las cuentas y los archivos de la carpeta no se eliminan. Si no se confirma la salida de un proceso, se conserva el proyecto para reintentar. La limpieza afecta a los datos gestionados por Agent Desk; los historiales y registros internos mantenidos por los CLI oficiales se administran por separado.

Un chat nuevo consulta los modelos antes del primer mensaje. Claude utiliza únicamente la inicialización del SDK con persistencia desactivada y sin enviar prompts; Codex consulta `model/list` en un proceso temporal. Ambos procesos se cierran al terminar o cancelar. No se crea un hilo remoto ni se bloquea la cuenta por consultar el catálogo. Si otra pestaña de la misma cuenta ya tiene modelos, se reutiliza esa lista en memoria. Se pueden escoger modelo, esfuerzo y permisos antes de enviar; un fallo del catálogo muestra el error y permite actualizarlo, sin inventar modelos disponibles. La cuenta se sigue bloqueando al comenzar la conversación.

Verificación: `tests/project-removal.test.ts` y `tests/prechat-models.test.ts` cubren limpieza, aislamiento, persistencia, fallos de parada y cancelaciones. `node scripts/prechat-project-check.mjs` recorre los controles de Electron con proveedores de prueba, incluido un arranque Claude bloqueado, eliminación con chats activos y limpieza de navegador/adjuntos/terminal. No consume modelos ni modifica proyectos reales. Estos cambios requieren reiniciar la app (protocolo IPC 18).

`node scripts/response-actions-check.mjs` (tras compilar) verifica los enlaces a entregables, la acción de mostrar en carpeta, el acceso por teclado y la posición del lector. Comprueba el motor nativo de voz en español con volumen silenciado, su parada y el cambio de respuesta/chat; no usa llamadas de modelo.

`node scripts/browser-auth-check.mjs` verifica ventanas emergentes reales, formularios POST, apertura en blanco, cookies PKCE compartidas, aislamiento por proyecto, conservación de cookies persistentes y localStorage tras reiniciar, limpieza al quitar proyectos y salida a Chrome con alternativa predeterminada. Usa datos y un servidor local de prueba; no inicia sesión en Google ni usa credenciales del usuario.

## Permisos de ChatGPT · Codex

El selector **Permisos de Codex** muestra el modo actual y ofrece cuatro opciones con su alcance: **Solo lectura**, **Preguntar antes de actuar**, **Trabajar en el proyecto** y **Acceso total**. Acceso total combina `danger-full-access` y `never`; desactivar preguntas por sí solo no amplía el sandbox. En la configuración avanzada, la política `never` se llama **Rechazar sin preguntar**. Se conservan las configuraciones anteriores, sin elevarlas automáticamente.

Cada `turn/start` envía el sandbox explícito, incluso en hilos ya cargados. Cambiar de modo durante una tarea muestra que se aplicará al siguiente mensaje; la autorización pendiente se responde en su propia tarjeta. Las solicitudes de acceso adicional distinguen **Permitir durante esta tarea** (`scope: turn`), **Permitir durante este chat** (`scope: session`) y **Rechazar**. Para comandos, la autorización de sesión se ofrece solo cuando el servidor anuncia `acceptForSession`, y se envía esa decisión sin convertirla en aprobación de una sola vez. Las decisiones no ofrecidas por el servidor no se muestran.

Reinicia las instancias anteriores (IPC 29). Verificación: `tests/codex-permissions.test.ts`, `npm test`, `npm run build` y `node scripts/codex-permissions-check.mjs`. La prueba de Electron usa un servidor simulado aislado, sin cuentas ni inferencia, y comprueba menú, IPC, acceso total, vuelta a solo lectura en el mismo hilo, duración de las aprobaciones y aviso durante una tarea. Capturas en `artifacts/codex-permisos-*.png`. Los campos del protocolo se contrastaron con los tipos generados por el binario Codex instalado.

## OpenCode · Console

En **Ajustes → Cuentas → Añadir cuenta**, elige **OpenCode · Console**. Pulsa **Iniciar sesión en el navegador**, completa el acceso oficial y autoriza el código que muestra Agent Desk. La cuenta se conecta automáticamente. Puedes volver a abrir la misma autorización, cancelarla o cambiar de cuenta. El acceso, la renovación y la organización se guardan cifrados mediante `safeStorage`, separados por perfil; no se exponen al renderer. Cerrar sesión elimina el acceso local, sin cerrar la sesión del navegador. También puedes introducir una clave API como alternativa; guardarla no hace consultas y su autenticación se comprueba al usarla.

En **Modelos que quieres probar**, carga el catálogo, marca los modelos y guarda la selección. Las cuentas nuevas parten con el filtro gratuito y sin modelos elegidos. Las cuentas existentes conservan sus elecciones. Desactiva **Mostrar solo modelos gratuitos** para seleccionar modelos de pago. Nunca se sustituye automáticamente un modelo elegido por otro de pago.

El catálogo se carga directamente desde la configuración autorizada de Console. Models.dev se usa solo si Console no ofrece catálogo (404 o configuración vacía); no es una descarga obligatoria para las cuentas conectadas. Esta integración incluye modelos de Chat Completions compatibles, como DeepSeek, Kimi, GLM, Qwen y MiniMax; los modelos que requieren protocolos Anthropic, Responses o Google no aparecen todavía. No se promete disponibilidad por aparecer en el catálogo. Se aplican los permisos y límites de la cuenta, incluidas las promociones temporales. El chat se ejecuta con el cliente oficial `@opencode/cli` 2.0.32 mediante ACP, en lugar de enviar directamente las solicitudes a la API. Se verificó una respuesta real de DeepSeek gratuito con este motor. Las promociones siguen sujetas a los límites de OpenCode. Los precios del catálogo son aproximados y no equivalen a las cuotas de una suscripción. Los espacios con políticas administradas requieren el cliente oficial para poder aplicarlas.

Conserva streaming, herramientas, permisos, historial y Multichat. El cliente oficial recibe un directorio aislado por chat y un token de acceso en memoria; el token de renovación sigue en el almacén cifrado de Agent Desk. No se importan credenciales en la base de datos del CLI. Las sesiones del motor se conservan para reanudar, y los chats anteriores de API pasan su historial de texto al nuevo motor. El modelo principal y los agentes auxiliares se fijan al modelo elegido; una selección no habilitada falla antes de enviar. Los permisos de herramientas parten de pedir aprobación y el motor también lee la configuración del proyecto. PDF adjunto no admitido: usa texto o procesa el archivo mediante las herramientas con permiso. No se muestran cuotas ni crédito inventados. La renovación de acceso es automática y los fallos de autorización piden iniciar sesión otra vez; los cambios de organización requieren un nuevo acceso.

Actualiza o reinicia Agent Desk para cargar el nuevo proveedor y el acceso por navegador (IPC 34). Verificación sin cuentas: `node --import tsx --test tests/opencode-runtime.test.ts tests/opencode.test.ts tests/providers.test.ts tests/openrouter-files.test.ts`. Referencias: [ACP oficial](https://opencode.ai/v2/docs/cli/acp/), [modelos oficiales](https://opencode.ai/v2/docs/console/models/), [flujo de acceso del cliente oficial](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/opencode.ts).
