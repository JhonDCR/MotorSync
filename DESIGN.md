---
name: MotorSync
description: Sistema visual táctil y de alta precisión para la gestión operativa en bahía automotriz
colors:
  primary: "#0b5394"
  primary-hover: "#083e6f"
  primary-deep: "#073763"
  primary-light: "#eef3f9"
  primary-wash: "#e8f4fd"
  focus: "#f1c232"
  warning-text: "#4d3200"
  warning-bg: "#fff4ce"
  warning-border: "#8a6d00"
  error: "#b00020"
  error-light: "#fdecee"
  neutral-text: "#1a1a1a"
  neutral-muted: "#4a4a4a"
  neutral-placeholder: "#888888"
  neutral-bg: "#ffffff"
  neutral-surface: "#f8f9fa"
  border: "#595959"
  border-light: "#d0d0d0"
  status-checkin: "#0b5394"
  status-checkin-bg: "#e8f4fd"
  status-budget: "#b45309"
  status-budget-bg: "#fef3e6"
  status-work-order: "#1e7e34"
  status-work-order-bg: "#e6f7ec"
  status-transfer: "#6b21a8"
  status-transfer-bg: "#f3e8fd"
  support-shell: "#0f172a"
  support-surface: "#1e293b"
  support-raised: "#334155"
  support-muted: "#cbd5e1"
  support-accent: "#1d4ed8"
  support-accent-hover: "#1e40af"
  support-danger: "#ef4444"
  admin-link: "#0969da"
  admin-success: "#1a7f37"
  admin-danger: "#cf222e"
  admin-border: "#d0d7de"
  admin-surface: "#f6f8fa"
typography:
  display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
  headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0em"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  body-ui:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.02em"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  badge: "12px"
  pill: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-bg}"
    typography: "{typography.body-ui}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.neutral-bg}"
    rounded: "{rounded.sm}"
  button-secondary:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.primary}"
    typography: "{typography.body-ui}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  button-on-cobalt:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.primary}"
    typography: "{typography.body-ui}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "44px"
  input-search:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    typography: "{typography.headline}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "60px"
  input-field:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "44px"
  plate-chip:
    backgroundColor: "{colors.primary-wash}"
    textColor: "{colors.primary}"
    typography: "{typography.display}"
    rounded: "{rounded.sm}"
    padding: "2px 12px"
  chip-filter:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    typography: "{typography.body-ui}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "44px"
  chip-filter-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-bg}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "44px"
  card-container:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.md}"
    padding: "16px"
  metric-box:
    backgroundColor: "{colors.neutral-surface}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.sm}"
    padding: "12px"
  badge-checkin:
    backgroundColor: "{colors.status-checkin-bg}"
    textColor: "{colors.status-checkin}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  badge-budget:
    backgroundColor: "{colors.status-budget-bg}"
    textColor: "{colors.status-budget}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  table-header:
    backgroundColor: "{colors.neutral-surface}"
    textColor: "{colors.neutral-muted}"
    typography: "{typography.label}"
    padding: "12px 16px"
    height: "44px"
  dialog-surface:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.md}"
    padding: "16px"
---

# Design System: MotorSync

## Overview

**Creative North Star: "The Precision Workshop"**

MotorSync adopta la estética de un taller automotriz de alta ingeniería: limpio, estructurado, directo y funcionalmente robusto. No es un portal administrativo estático ni un ERP genérico; es una herramienta de campo concebida para asesores de servicio y mecánicos que operan en movimiento sobre tablets en la bahía de recepción e inspección. Cada píxel responde a la necesidad de certeza legal, rapidez diagnóstica y ergonomía táctil bajo condiciones ambientales reales (ruido, iluminación variable y manipulación con dedos o guantes).

La densidad visual es calculada: generosa en los objetivos de interacción crítica para evitar errores de digitación en la bahía, pero rigurosamente compacta y tabular en la presentación de historiales clínicos, líneas de presupuesto y parámetros técnicos del vehículo. Se descarta cualquier adorno superfluo o efecto cosmético que opaque los datos periciales.

El sistema se apoya en una sola familia de trabajo, Inter, y una sola idea cromática: un cobalto institucional que marca jerarquía, fondos tonales claros que separan capas, y un ámbar de señalización que pertenece exclusivamente al foco. El resultado debe sentirse como una herramienta calibrada, no como una aplicación de consumo: bordes firmes, placas tipográficas tratadas como matrícula metálica, y evidencia (fotos, firma, daños) enmarcada con la misma solemnidad que un parte pericial.

**Key Characteristics:**
- Ergonomía táctil no negociable (objetivos mínimos de 44 × 44 px en bahía).
- Contraste cromático estricto (cumplimiento integral WCAG 2.1 AA sobre fondos claros).
- Profundidad plana y estructurada: bordes sólidos y fondos tonales; las sombras difusas son la excepción documentada, no la regla.
- Tipografía Inter con cifras tabulares para VIN, kilometraje y valores económicos.
- Indicadores semánticos unívocos por tipo de evento técnico (check-in, presupuesto, orden de trabajo, transferencia).
- Tres dialectos visuales delimitados: el núcleo cobalto, el shell oscuro de Soporte y las tablas administrativas de Usuarios. Ninguno invade el territorio de otro.

## Colors

La paleta equilibra un azul cobalto institucional de alta solidez con acentos funcionales de seguridad vial y advertencia industrial, sobre una base neutra casi blanca que mantiene legibilidad bajo luz de taller.

### Primary
- **Precision Cobalt Navy** (`#0b5394`): Color rector de la plataforma. Identifica el header de la aplicación, acciones primarias confirmatorias, enlaces activos, texto y borde de la placa vehicular, y el módulo de recepción / check-in.
- **Deep Cobalt Pressed** (`#083e6f`): Estado hover y borde inferior del header en botones primarios del núcleo.
- **Legacy Pressed Cobalt** (`#073763`): Hover heredado de los módulos Usuarios y formularios administrativos. Se conserva por continuidad; no debe introducirse en pantallas nuevas.
- **Cobalt Mist Tint** (`#eef3f9`): Fondos de hover secundario, avisos informativos y superficies de apoyo.
- **Cobalt Wash** (`#e8f4fd`): Relleno del chip de placa y del badge de check-in.

### Secondary
- **Bay Safety Amber** (`#f1c232`): Acento de alta visibilidad inspirado en la señalética de seguridad de taller. Dedicado en exclusiva al anillo de foco accesible (`outline: 3px solid`) y al punto de marca del logo y del hero de autenticación.
- **Advisory Ochre** (`#8a6d00` / `#fff4ce` / `#4d3200`): Tríada de advertencia no bloqueante (borde, relleno, texto) para avisos de validación suave, como la discrepancia entre placa y RUC. El borde usa el ocre oscuro porque `#d1a313` sobre Parchment solo alcanza 2.13:1; `#8a6d00` llega a 4.47:1 y mantiene el borde legible con sol directo. Nunca sustituye al ámbar de foco.

### Neutral
- **Deep Carbon Text** (`#1a1a1a`): Texto principal, encabezados y trazo de la firma digital. Contraste superior a 12:1 sobre blanco.
- **Workshop Muted Gray** (`#4a4a4a`): Texto secundario, etiquetas descriptivas, kilometraje y metadatos de fecha/hora.
- **Placeholder Gray** (`#888888`): Texto de placeholder en campos de autenticación.
- **Industrial Solid Border** (`#595959`): Delimitador de campos interactivos, bordes de botón secundario, contorno de tarjeta activa y marco del lienzo de firma.
- **Surface Divider Gray** (`#d0d0d0`): Bordes de tarjetas pasivas, separadores de sección y líneas de rejilla en listas.
- **Clinical White** (`#ffffff`): Fondo de pantalla, lienzo de tarjetas y texto sobre cobalto.
- **Diagnostic Tint Gray** (`#f8f9fa`): Fondo de módulos métricos, cabeceras de tabla y contenedores pasivos.

### Semantic Status
- **Critical Crimson** (`#b00020`): Errores de formulario, validación inválida (`aria-invalid="true"`) y acciones destructivas. Fondo asociado `#fdecee`.
- **Service Green** (`#1e7e34`): Órdenes de trabajo en ejecución o completadas. Fondo asociado `#e6f7ec`.
- **Estimate Ochre** (`#b45309`): Presupuestos cotizados o pendientes de aprobación. Fondo asociado `#fef3e6`.
- **Transfer Deep Purple** (`#6b21a8`): Transferencias de titularidad y reasignación de propietario. Fondo asociado `#f3e8fd`.

### Module Dialects
- **Support Slate** (`#0f172a` shell, `#1e293b` hover, `#334155` activo, `#cbd5e1` texto atenuado, `#f8fafc` texto principal): Identidad propia del portal de Soporte MotorSync. Es el único lugar de la plataforma donde se permite un shell oscuro. Su acción primaria usa **Support Action Blue** (`#1d4ed8`, hover `#1e40af`) y su error **Support Alarm Red** (`#ef4444`).
- **Admin Table Palette** (`#0969da` enlace, `#1a7f37` éxito, `#cf222e` peligro, `#d0d7de` borde, `#f6f8fa` cabecera): Dialecto heredado de las pantallas de Usuarios. Vive solo en tablas y formularios administrativos y es candidato a converger al núcleo cobalto; no se replica en módulos nuevos.

### Named Rules
**The Focus Exclusivity Rule.** El ámbar (`#f1c232`) está reservado estrictamente para el foco accesible de teclado y toque, el logo y el detalle del hero de autenticación. Nunca se usa como fondo de botón, texto de estado ni color decorativo de datos.

**The Semantic State Rule.** Cada estado de la orden o del historial técnico emplea un único par cromático (texto + fondo tonal) que jamás se intercambia entre módulos: check-in cobalto, presupuesto ocre, orden de trabajo verde, transferencia púrpura.

**The Module Dialect Rule.** El cobalto es la norma. El shell slate existe solo bajo `/support`; la paleta tipo GitHub existe solo en tablas y formularios de `/users`. Una pantalla nueva no elige dialecto: hereda el núcleo.

## Typography

**Display & Body Font:** Inter (`400`, `500`, `600`, `700`) cargada desde Google Fonts, con pila de respaldo nativa (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`).

**Character:** Tipografía neutral, robusta y técnica. Inter aporta claridad a tamaños pequeños y cifras de ancho fijo; la pila de sistema garantiza renderizado inmediato si la fuente no llega. La jerarquía se construye con peso y espaciado, no con familias decorativas.

### Hierarchy
- **Display / Plate** (Bold 700, `1.75rem` [28px], line-height 1.2, letter-spacing `0.08em`, mayúsculas sostenidas): Placa vehicular ecuatoriana en ficha, historial y resultados de búsqueda; identificador de cabecera.
- **Headline** (Bold 700, `1.5rem` [24px], line-height 1.25, letter-spacing `-0.01em`): Título de página (`h1`) y campo de búsqueda de placa en bahía.
- **Title** (Semi-bold 600, `1.125rem`–`1.25rem` [18–20px], line-height 1.3): Encabezados de tarjeta (`h2`), títulos de evento y modales.
- **Body** (Regular 400, `1rem` [16px], line-height 1.5): Valores de formulario, descripciones de evento, texto de lectura. Longitud de línea óptima 60–75 caracteres.
- **Body / UI** (Regular 400, `0.875rem` [14px], line-height 1.5): Texto dominante de la interfaz: botones, enlaces, filas de lista, ayudas.
- **Label / Micro** (Semi-bold 600, `0.75rem`–`0.8125rem` [12–13px], line-height 1.2, letter-spacing `0.02em`–`0.04em`, mayúsculas en etiquetas de estado): Badges, `dt` de fichas técnicas, marcas de tiempo y notas secundarias.

### Named Rules
**The Tabular Data Rule.** Todo kilometraje, número de VIN, código de repuesto, valor monetario, fecha de evento o desglose de presupuesto aplica `font-variant-numeric: tabular-nums` para conservar alineación vertical en columnas.

**The Plate Prominence Rule.** Las placas vehiculares se representan normalizadas en mayúsculas, con `letter-spacing: 0.08em` y peso 700, sobre relleno Cobalt Wash y borde cobalto de 1px, simulando la placa física metálica.

**The Two-Step Body Rule.** La interfaz operativa escribe en `0.875rem`; los campos de entrada, los valores de ficha y el texto de lectura suben a `1rem`. No se inventan tamaños intermedios (`0.9rem`, `0.95rem`): son deuda heredada.

## Layout

MotorSync usa un modelo espacial **Mobile/Tablet-First** de una sola columna que se ensancha sin reordenar el flujo: el contenido crece, la estructura no se convierte en dashboard.

- **Bahía móvil (360px–767px):** padding perimetral de `16px`. Todo formulario e input a ancho completo. Toolbars y acciones se apilan; el header de la app apila marca, navegación desplazable y barra de sesión.
- **Tablet (768px–1023px):** padding vertical de `32px` y horizontal de `16px`. El header pasa a fila única (marca + nav + sesión). Los grids de métricas se resuelven en 4 columnas.
- **Escritorio (≥1024px):** aparecen la barra lateral de autenticación y las tablas anchas de administración; el contenido de bahía conserva sus anchos máximos.
- **Anchos de contenido por tipo de pantalla:** formularios `44rem` (704px); búsqueda, ficha, check-in y detalle de cliente `48rem` (768px); historial clínico `56rem` (896px); administración de usuarios `64rem` (1024px); soporte `72rem` (1152px); tarjeta de autenticación `28rem` (448px), `34rem` en registro.
- **Split de autenticación (≥960px):** panel hero al 48% del ancho con máximo `580px`, formulario centrado en el resto.
- **Grids utilitarios:** métricas `repeat(auto-fit, minmax(140px, 1fr))`; líneas de presupuesto `repeat(auto-fit, minmax(130px, 1fr))`.
- **Ritmo espacial:** múltiplos de 4px — `4` xs, `8` sm, `12` md, `16` lg, `24` xl, `32` xxl.

### Named Rules
**The Single-Column First Rule.** Toda pantalla nueva se diseña y se valida primero a 360px de ancho. El layout de escritorio es una ampliación del flujo móvil, nunca una reordenación que oculte acciones de bahía.

## Elevation & Depth

MotorSync es **plano por defecto**: la profundidad se comunica con bordes sólidos de 1px, fondos tonales y cambios de borde en hover, porque la luz cenital de reflectores y el sol exterior anulan las sombras tenues. Existen tres excepciones sancionadas, cada una ligada a un objeto flotante real: la tarjeta de autenticación, los diálogos modales y el contenedor de tabla.

### Shadow Vocabulary
- **Auth Card Lift** (`--shadow-auth-card` → `0 4px 16px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.08)`): Solo la tarjeta de inicio de sesión / registro, para separarla del lienzo blanco.
- **Dialog Lift** (`--shadow-dialog` → `0 20px 25px -5px rgba(15, 23, 42, 0.25)`): Todo diálogo modal sobre el backdrop al 55%, en el núcleo y en los dialectos.
- **Table Hairline** (`--shadow-table-hairline` → `0 1px 3px rgb(0 0 0 / 5%)`): Contenedor de tabla administrativa; separa la tabla del fondo sin dibujar un marco pesado.
- **Backdrop** (`background: rgb(0 0 0 / 55%)`): Velo único de los modales del núcleo.

Estas tres elevaciones son las únicas sombras declaradas en `styles.scss`. El shell de navegación **no** lleva sombra: se separa del contenido con `border-bottom: 2px solid var(--color-primary-hover)`.

### Live Signal
- **Live Dot Glow** (`--glow-live` → `0 0 6px #22c55e`): Emisión de luz del punto verde de estado en la pantalla de autenticación. No es elevación — no comunica altura sino señal — y por eso vive fuera de los tres lifts.

### Named Rules
**The Flat-By-Default Rule.** En reposo, tarjetas, listas, fichas, métricas y eventos no llevan sombra difusa. La jerarquía se resuelve con borde `1px` `#d0d0d0` (pasivo) o `#595959` (interactivo) y con el salto de blanco a `#f8f9fa`.

**The Three-Lift Rule.** Las únicas elevaciones permitidas son Auth Card Lift (`--shadow-auth-card`), Dialog Lift (`--shadow-dialog`) y Table Hairline (`--shadow-table-hairline`). Cualquier sombra nueva debe reemplazar una de las tres, no sumarse.

**The State Elevation Rule.** El cambio de profundidad en hover se expresa con fondo tonal (`#f8f9fa`) y borde más oscuro; nunca con sombra.

## Shapes

El lenguaje formal comunica solidez industrial con esquinas apenas suavizadas:

- **Radio estándar `4px`:** botones, inputs, chips de placa, tarjetas dentro de listas, avisos, badges de estado y lienzo de firma.
- **Radio de contenedor `6px`:** tarjetas madre (`.card`), contenedor de tabla y diálogos en escritorio.
- **Radio heredado `8px`:** superficies, botones y píldoras del portal de Soporte y de las pantallas de Usuarios. Deuda del dialecto; no se propaga al núcleo.
- **Píldora `20px`:** chips de filtro de historial y tableros, y contador del mapa de daños.
- **Badge administrativo `12px`:** solo badges de rol y estado en tablas de Usuarios.
- **Trazo perimetral:** `1px` sólido en reposo; `2px` en el campo de búsqueda de placa y en cualquier campo con error. El foco añade `outline` de 3px, no engorda el borde.
- **Círculo perfecto:** únicamente el punto de estado del hero (`8px`) y los indicadores de presencia.

### Named Rules
**The Four-Pixel Core Rule.** El núcleo cobalto usa `4px` y `6px`. Si una superficie nueva pide más suavidad, la respuesta es un borde más claro, no un radio mayor.

## Components

### Buttons
- **Shape:** rectangular con esquinas de `4px`; altura mínima `44px`, `48px` en acciones primarias de formulario y autenticación.
- **Primary:** fondo Precision Cobalt Navy, texto blanco, padding `0 16px`–`0 24px`, peso 600. Hover a Deep Cobalt Pressed; `:active` baja 1px en autenticación.
- **Secondary / Action:** fondo blanco, texto y borde cobalto de 1px. Hover a Cobalt Mist Tint. Es el botón de "Cancelar", "Volver" y acciones de fila.
- **On Cobalt:** en el header azul, botón blanco con texto cobalto (`Cerrar sesión`), borde blanco, mismo objetivo táctil.
- **Disabled:** `opacity: 0.7` y cursor de progreso mientras guarda; nunca se oculta la etiqueta.
- **Focus:** `outline: 3px solid #f1c232; outline-offset: 2px` en todos los botones, enlaces y campos.

### Inputs / Search Fields
- **Bay Search Plate:** campo sobredimensionado de `60px` (3.75rem), texto `1.5rem` peso 700 en mayúsculas y `0.08em`, borde `2px` `#595959`, radio `4px`. Es el elemento más grande de la pantalla de búsqueda.
- **Standard Field:** altura mínima `44px`, texto `1rem`, borde `1px` `#595959`, padding horizontal `12px`, radio `4px`.
- **Validation:** `aria-invalid="true"` cambia a borde `2px` Critical Crimson; en autenticación añade fondo `#fffbfa`. El mensaje de error vive debajo del campo, en `0.875rem` peso 500.
- **Focus:** borde cobalto + `outline` ámbar de 3px con offset 2px.
- **Selects y textareas:** misma geometría; textarea mínimo `5rem`–`6rem`, `resize: vertical`.

### Plate Chip
- **Style:** pastilla inline con relleno Cobalt Wash, borde cobalto de 1px, radio `4px`, padding `2px 10px`–`2px 12px`, Inter 700 en mayúsculas y `0.08em`.
- **Sizes:** `1.75rem` en ficha e historial; `1.125rem` en resultados de búsqueda; `0.875rem` en listas de cliente.
- **Behavior:** nunca se parte en dos líneas ni se muestra en minúsculas.

### Cards / Metrics
- **Container Card:** blanco, borde `1px` `#d0d0d0`, radio `6px`, padding `16px`; en hover, fondo `#f8f9fa` y borde `#595959` cuando es clicable.
- **Metric Box:** fondo Diagnostic Tint Gray, borde `1px` `#d0d0d0`, radio `4px`, padding `12px`; etiqueta `0.75rem` mayúsculas en Workshop Muted Gray y valor `1.25rem` peso 700 con cifras tabulares.
- **Metric Grid:** `repeat(auto-fit, minmax(140px, 1fr))`, 4 columnas desde `768px`.

### Timeline Events
- **Structure:** tarjeta blanca con borde `1px` `#d0d0d0`, radio `6px`, padding `12px 16px`; cabecera con badge semántico + fecha tabular, resumen y enlace de detalle subrayado.
- **State:** hover a fondo `#f8f9fa` y borde `#595959`. La categoría se comunica con el badge, no con una barra lateral de color.
- **Print:** el historial se imprime en blanco y negro; badges y placas pierden relleno y conservan borde.

### Status Badges
- **Style:** `padding: 3px 8px`, radio `4px`, `0.75rem` peso 700 en mayúsculas y `0.04em`; texto del color semántico, fondo tonal y borde `1px` del mismo color al 25% de opacidad.
- **Kinds:** `checkin`, `budget`, `work_order`, `ownership_transfer`; el par cromático no se reutiliza para otro significado.

### Chips & Filter Pills
- **Style:** píldora `20px`, altura `44px`, padding `0 16px`, fondo blanco y borde `#d0d0d0`.
- **Active:** fondo cobalto, texto blanco, borde cobalto. Hover previo sobre fondo `#f8f9fa`.
- **Counter badge:** dentro del chip, píldora translúcida blanca; en estado activo, blanco al 25%.

### Data Tables
- **Wrapper:** borde `1px`, radio `6px`, `overflow-x: auto` y Table Hairline; el scroll horizontal es obligatorio en móvil.
- **Header:** fondo `#f6f8fa` o `#f1f5f9`, texto `0.8125rem` peso 600 en gris atenuado en el núcleo (`0.9375rem`–`0.95rem` en los dialectos heredados), padding `12px 16px`, `white-space: nowrap`.
- **Rows:** borde inferior `1px` (#eaeef2 en Usuarios, #e2e8f0 en Soporte), hover `#f9fbfd`; la última fila no dibuja borde.
- **Cells:** texto `0.875rem` en el núcleo; enlaces cobalto subrayados al hover; acciones con objetivo táctil de 44px.

### Dialogs
- **Mobile:** pantalla completa, fondo blanco, sin radio, padding `16px`, scroll interno.
- **Desktop (≥768px):** tarjeta centrada de máximo `36rem`, radio `6px`, padding `24px`, `max-height: calc(100vh - 4rem)`.
- **Backdrop:** negro al 55%; el diálogo se alinea arriba en móvil y al centro en escritorio.
- **Actions:** apiladas a ancho completo en móvil; fila alineada al final en escritorio.

### Navigation Shell
- **Header:** franja cobalto sticky, borde inferior `2px` Deep Cobalt Pressed; marca con logo ámbar, nombre y tagline en `0.75rem` mayúsculas al 70% de blanco.
- **Nav:** enlaces de 44px, borde blanco translúcido de 1px, icono de 18px; hover con blanco al 15%; activo invertido (fondo blanco, texto cobalto, peso 700). La fila es desplazable horizontalmente y oculta su scrollbar.
- **Session Bar:** usuario en blanco 700, rol como chip mayúsculas sobre blanco al 15%, taller con viñeta; se apila bajo la marca en móvil y se alinea a la derecha desde `768px`.
- **Visibilidad:** el header completo se oculta en autenticación y en el portal de Soporte, que monta su propio shell; la navegación de taller se oculta además mientras hay una contraseña temporal pendiente.

### Auth Split-Screen
- **Hero (≥960px):** panel oscuro `#061e38` con degradado a cobalto sobre `workshop-hero.jpg`, retícula de puntos ámbar de 24px al 18%, eslogan blanco de `2rem` con `-0.02em`, tres pilares con iconos de trazo ámbar y panel translúcido, y nota de estado con punto verde pulsante.
- **Form Card:** máximo `28rem` (registro `34rem`), padding `32px`, borde `1px` `#d0d0d0`, radio `6px` y Auth Card Lift. El badge de marca va sobre Cobalt Mist Tint con borde cobalto al 20%.
- **Mobile:** el hero desaparece; el eslogan se reduce a una línea de `0.75rem` mayúsculas bajo el título.

### Signature Pad
- **Canvas:** 600×200 px lógicos, `aspect-ratio: 3 / 1`, ancho máximo `600px`, fondo blanco, borde `1px` `#595959`, radio `4px`, `touch-action: none`.
- **Ink:** trazo `#1a1a1a` de 3px, extremos redondeados. La firma es evidencia: el lienzo nunca lleva fondo tonal, sombra ni decoración.
- **Action:** "Borrar firma" de 44px, deshabilitado mientras no hay trazo.

### Damage Map (360°)
- **Frame:** `fieldset` tipo tarjeta con borde `1px` `#d0d0d0`, radio `6px`, padding `16px`, `legend` de `1rem` peso 700.
- **View Selector:** chips de 44px con borde `#d0d0d0`; el seleccionado invierte a cobalto y su contador pasa a blanco al 25%.
- **Add Row:** bloque sobre `#f8f9fa` con borde claro, inputs de 44px y acción secundaria; los daños listados son filas blancas de 44px con acción "Eliminar" en Critical Crimson.

### Notices & Alerts
- **Style:** franja de ancho completo, padding `12px 16px`, radio `4px`, texto `0.875rem`–`1rem`.
- **Info:** texto cobalto, fondo Cobalt Mist Tint, borde cobalto.
- **Error:** texto Critical Crimson, fondo Crimson Wash, borde Critical Crimson; usa `role="alert"`.
- **Warning:** texto Umber Warning Text, fondo Parchment Warning, borde Advisory Ochre oscuro. Es advertencia, no error. Un aviso de cambio obligatorio (`.must-change`) usa esta tríada; nunca la informativa cobalto de `.session-reason`.

## Do's and Don'ts

### Do:
- **Do** garantizar que todo elemento interactivo o clicable cumpla como mínimo `44 × 44 px` de área de toque, incluidos enlaces dentro de párrafos y acciones de fila.
- **Do** presentar siempre placas ecuatorianas en mayúsculas, peso 700 y `letter-spacing: 0.08em` sobre Cobalt Wash.
- **Do** emplear `tabular-nums` para kilometrajes, cotizaciones, fechas y códigos técnicos.
- **Do** usar el `outline` ámbar de 3px con offset 2px como indicador universal de foco visible.
- **Do** mantener el fondo blanco o tonal claro con bordes sólidos de alto contraste para visibilidad en bahía.
- **Do** escribir la interfaz operativa en `0.875rem` y reservar `1rem` para campos, valores de ficha y lectura.
- **Do** usar `role="alert"` para errores de guardado y `aria-invalid` + mensaje asociado por `aria-describedby` en cada campo.
- **Do** confinar el shell slate a `/support` y la paleta tipo GitHub a tablas y formularios de `/users`; cualquier pantalla nueva hereda el núcleo cobalto.

### Don't:
- **Don't** aplicar degradados decorativos, sombras difusas adicionales o "glassmorphism"; las únicas elevaciones permitidas son Auth Card Lift, Dialog Lift y Table Hairline.
- **Don't** usar textos en grises claros que violen el ratio mínimo 4.5:1 (WCAG AA) sobre fondo claro.
- **Don't** crear botones compactos de escritorio (< 44px) en pantallas operativas de bahía.
- **Don't** alterar los códigos cromáticos semánticos de check-in, presupuesto, orden de trabajo y transferencia.
- **Don't** reutilizar el ámbar `#f1c232` como color de estado, fondo o texto de datos; su rareza es la señal.
- **Don't** introducir animaciones lentas o transiciones cosméticas que retarden la captura de información en recepción.
- **Don't** añadir radios de `8px` ni badges de `12px` al núcleo cobalto; pertenecen a los dialectos heredados.
- **Don't** crear una nueva pantalla de bahía con un shell de navegación oscuro: el único shell oscuro es el de Soporte.
- **Don't** usar la tríada Warning para mensajes informativos ni la informativa cobalto para advertencias: `.must-change` es advertencia, `.session-reason` es información.
- **Don't** escribir valores de `box-shadow` a mano: usa `--shadow-auth-card`, `--shadow-dialog` o `--shadow-table-hairline`. Un cuarto valor rompe la Three-Lift Rule.
- **Don't** reutilizar `--glow-live` fuera del punto verde de estado: es señal de "en vivo", no una elevación.
