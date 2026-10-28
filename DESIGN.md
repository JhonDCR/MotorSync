---
name: MotorSync
description: Sistema visual táctil y de alta precisión para la gestión operativa en bahía automotriz
colors:
  primary: "#0b5394"
  primary-hover: "#083e6f"
  primary-light: "#eef3f9"
  focus: "#f1c232"
  error: "#b00020"
  error-light: "#fdecee"
  neutral-text: "#1a1a1a"
  neutral-muted: "#4a4a4a"
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
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.05em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.025em"
rounded:
  sm: "4px"
  md: "6px"
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
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.neutral-bg}"
  button-secondary:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.primary}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  input-field:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "44px"
  input-search:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "56px"
  chip-filter:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "44px"
  chip-filter-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral-bg}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "44px"
  card-container:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.md}"
    padding: "16px"
  badge-status:
    backgroundColor: "{colors.status-checkin-bg}"
    textColor: "{colors.status-checkin}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
---

# Design System: MotorSync

## Overview

**Creative North Star: "The Precision Workshop"**

MotorSync adopta la estética de un taller automotriz de alta ingeniería: limpio, estructurado, directo y funcionalmente robusto. No es un portal administrativo estático ni un ERP genérico; es una herramienta de campo concebida para asesores de servicio y mecánicos que operan en movimiento sobre tablets en la bahía de recepción e inspección. Cada píxel responde a la necesidad de certeza legal, rapidez diagnóstica y ergonomía táctil bajo condiciones ambientales reales (ruido, iluminación variable y manipulación con dedos o guantes).

La densidad visual es calculada: generosa en los objetivos de interacción crítica para evitar errores de digitación en la bahía, pero rigurosamente compacta y tabular en la presentación de historiales clínicos, líneas de presupuesto y parámetros técnicos del vehículo. Se descarta cualquier adorno superfluo o efecto cosmético que opaque los datos periciales.

**Key Characteristics:**
- Ergonomía táctil no negociable (objetivos mínimos de 44 × 44 px en bahía).
- Contraste cromático estricto (cumplimiento integral WCAG 2.1 AA sobre fondos claros).
- Profundidad plana y estructurada (ausencia de sombras difusas; jerarquía lograda mediante bordes sólidos y fondos tonales).
- Tipografía de lectura inmediata con números tabulares para VIN, kilometraje y valores económicos.
- Indicadores semánticos unívocos por tipo de evento técnico (check-in, presupuesto, orden de trabajo, transferencia).

## Colors

La paleta cromática de MotorSync equilibra un azul cobalto institucional de alta solidez con acentos funcionales de seguridad vial y advertencia industrial.

### Primary
- **Precision Cobalt Navy** (`#0b5394`): Color rector de la plataforma. Identifica el shell de la aplicación, acciones primarias confirmatorias, enlaces activos y el módulo de recepción / check-in.
- **Deep Cobalt Pressed** (`#083e6f`): Estado activo e interactivo de botones primarios.
- **Cobalt Mist Tint** (`#eef3f9` / `#e8f4fd`): Superficies de información contextual, avisos informativos y fondo del badge de check-in.

### Secondary
- **Bay Safety Amber** (`#f1c232`): Acento cromático de alta visibilidad inspirado en la señalética de seguridad en talleres. Dedicado en exclusiva a anillos de foco accesible (`outline: 3px solid #f1c232`) y alertas de atención operativa sin error crítico.

### Neutral
- **Deep Carbon Text** (`#1a1a1a`): Color principal de texto y encabezados. Garantiza contraste superior a 12:1 sobre fondo blanco.
- **Workshop Muted Gray** (`#4a4a4a`): Texto secundario, etiquetas descriptivas, kilometraje y metadatos de fecha/hora.
- **Industrial Solid Border** (`#595959`): Delimitador de campos de formulario interactivos, bordes de botón secundario y contornos de tarjeta activa.
- **Surface Divider Gray** (`#d0d0d0`): Bordes de tarjetas pasivas, separadores de sección y líneas de rejilla en listas.
- **Clinical White** (`#ffffff`): Fondo de pantalla principal y lienzos de tarjetas.
- **Diagnostic Tint Gray** (`#f8f9fa`): Fondo de módulos métricos, cabeceras de tablas y contenedores pasivos.

### Semantic Status
- **Critical Crimson** (`#b00020`): Mensajes de error en formularios, estados de validación inválida (`aria-invalid="true"`) y cancelaciones. Fondo asociado `#fdecee`.
- **Service Green** (`#1e7e34`): Órdenes de trabajo en ejecución o completadas. Fondo asociado `#e6f7ec`.
- **Estimate Ochre** (`#b45309`): Presupuestos cotizados o pendientes de aprobación del cliente. Fondo asociado `#fef3e6`.
- **Transfer Deep Purple** (`#6b21a8`): Transferencias de titularidad de vehículo y reasignación de propietario. Fondo asociado `#f3e8fd`.

### Named Rules
**The Focus Exclusivity Rule.** El color ámbar (`#f1c232`) está reservado estrictamente para el foco accesible del teclado y toque; nunca se utiliza como fondo de botón ni como color decorativo.

**The Semantic State Rule.** Cada estado de la orden o del historial técnico emplea un único par cromático (borde/texto + fondo tonal al 10% de opacidad) que jamás se intercambia entre módulos.

## Typography

**Display & Body Font:** Pila de sistema nativa limpia (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`).

**Character:** Tipografía neutral, robusta y técnica. Prioriza la tasa de refresco, el renderizado nítido en pantallas de gama media y la legibilidad inmediata a distancia de brazo.

### Hierarchy
- **Display / Plate** (Bold 700, `1.5rem` a `1.75rem` [24px - 28px], line-height 1.2, letter-spacing `0.05em`, `text-transform: uppercase`): Reservado para la placa vehicular ecuatoriana y el identificador de cabecera en fichas técnicas.
- **Headline** (Semi-bold 600, `1.5rem` [24px], line-height 1.25): Títulos de página y cabeceras de sección principal (ej. "Buscar vehículo", "Historial clínico").
- **Title** (Semi-bold 600, `1.125rem` a `1.25rem` [18px - 20px], line-height 1.3): Encabezados de tarjetas, títulos de eventos en la línea de tiempo y modales.
- **Body** (Regular 400, `1rem` [16px], line-height 1.5): Texto estándar de lectura, valores de formulario e instrucciones generales. Longitud de línea óptima: 60–75 caracteres.
- **Label / Micro** (Semi-bold 600, `0.75rem` a `0.8125rem` [12px - 13px], line-height 1.2): Badges de estado, etiquetas métricas, marcas de tiempo y notas secundarias.

### Named Rules
**The Tabular Data Rule.** Todo kilometraje, número de VIN, código de repuesto, valor monetario o desglose de presupuesto debe aplicar `font-variant-numeric: tabular-nums` para conservar alineación vertical perfecta en columnas.

**The Plate Prominence Rule.** Las placas vehiculares siempre se representan normalizadas en mayúsculas sostenidas, con espacio entre letras (`letter-spacing: 0.05em`) y peso 700, simulando la placa física metálica.

## Layout

MotorSync utiliza un modelo espacial **Mobile/Tablet-First** estructurado en una sola columna en pantallas de bahía (desde 360 px), que se expande progresivamente en cuadrículas utilitarias a partir de 768 px y 1024 px.

- **Bahía móvil (360px - 767px):** Margen perimetral de `1rem` (16px). Disposición vertical en flujo continuo. Formulario e inputs a ancho completo (`width: 100%`) para maximizar la superficie de contacto.
- **Tablet / Bahía horizontal (768px - 1023px):** Contenedor centralizado con ancho máximo de `40rem` a `52rem` (640px - 832px) y padding de `1.5rem` a `2rem`. La cabecera reorganiza la barra de sesión y navegación en línea horizontal.
- **Escritorio / Oficina (≥ 1024px):** Rejillas adaptativas (`grid-template-columns: repeat(auto-fit, minmax(130px, 1fr))`) para tableros de métricas y visualización de órdenes.
- **Ritmo espacial base:** Múltiplo de 4px: `4px` (xs), `8px` (sm), `12px` (md), `16px` (lg), `24px` (xl), `32px` (xxl).

## Elevation & Depth

MotorSync adopta una filosofía de **cero sombras difusas en reposo (Flat & Bordered)**. 

En un taller automotriz, la luz cenital de reflectores y los reflejos del sol en exteriores anulan el contraste de las sombras tenues (`box-shadow` borrosas). La profundidad y jerarquía se comunican categóricamente mediante:
1. **Contraste de línea perimetral:** Bordes definidos de `1px` a `2px` sólidos (`#595959` para elementos interactivos; `#d0d0d0` para contenedores pasivos).
2. **Capas tonales de superficie:** Fondo blanco (`#ffffff`) en lienzo de trabajo, alternado con fondos técnicos tenues (`#f8f9fa`) en resúmenes y tonalidades pastel en avisos de sistema.
3. **Indicador de barra lateral:** Las tarjetas de eventos del historial técnico destacan su categoría mediante un borde izquierdo sólido de `4px` con el color semántico de la entidad.

### Named Rules
**The No-Fuzzy-Shadow Rule.** Ningún componente en reposo utiliza `box-shadow` difuso. La separación espacial se resuelve mediante bordes sólidos y fondos contrastados.

**The State Elevation Rule.** El único cambio de profundidad permitido ocurre en hover táctil o enfoque, alterando el fondo tonal (`#f3f6fa`) y activando el contorno de foco sólido (`outline: 3px solid #f1c232`).

## Shapes

El lenguaje formal de MotorSync comunica solidez industrial:
- **Radio estándar:** `4px` en botones, inputs de texto, tarjetas de eventos, avisos informativos y selectores. Brinda esquinas sutilmente suavizadas sin caer en formas orgánicas o lúdicas.
- **Radio de contenedor:** `6px` en tarjetas madre (`.card`) y diálogos modales.
- **Radio de filtro / chip:** `20px` (forma píldora) exclusivo para selectores rápidos de filtrado en líneas de tiempo y tableros.
- **Trazo perimetral:** 1px sólido en reposo; 2px sólido en campos de búsqueda prioritaria e inputs con error.

## Components

### Buttons
- **Shape:** Rectangular con esquinas suavizadas (`border-radius: 4px`).
- **Primary:** Fondo `Precision Cobalt Navy` (`#0b5394`), texto blanco, padding `0 16px`, altura mínima de `44px`, peso 600.
- **Hover / Active:** Fondo `#083e6f` en hover; borde ámbar `#f1c232` en foco accesible.
- **Secondary / Action:** Fondo blanco, texto y borde `#0b5394` de 1px, altura mínima de `44px`.

### Inputs / Search Fields
- **Search Plate Input (Bahía):** Campo sobredimensionado para digitación rápida de placas. Altura mínima de `3.5rem` (56px), fuente de `1.5rem` en mayúsculas sostenidas (`letter-spacing: 0.05em`), borde de 2px sólido `#595959`, radio `4px`.
- **Standard Field:** Altura mínima de `44px`, texto `#1a1a1a`, borde 1px sólido `#595959`, padding horizontal `12px`.
- **Validation State:** Si `aria-invalid="true"`, borde de 2px sólido `Critical Crimson` (`#b00020`).
- **Focus:** `outline: 3px solid #f1c232`, `outline-offset: 2px`.

### Cards & Metrics
- **Container Card:** Fondo blanco, borde de 1px sólido `#d0d0d0`, radio `6px`, padding `16px`.
- **Metric Box:** Contenedor de datos numéricos con fondo `#f8f9fa`, borde `#d0d0d0`, radio `4px`, etiqueta de `0.8125rem` `#4a4a4a` y valor en negrita `1.125rem` con cifras tabulares.
- **Timeline Event Card:** Tarjeta con borde izquierdo de `4px` del color semántico del evento (`#0b5394` checkin, `#b45309` presupuesto, `#1e7e34` OT, `#6b21a8` transferencia).

### Chips & Filter Pills
- **Style:** Botones redondeados tipo píldora (`border-radius: 20px`), padding `0 14px`, altura mínima de `44px`, fondo blanco y borde `#d0d0d0`.
- **Active State:** Fondo `#0b5394`, texto blanco y borde `#0b5394`.

### Navigation Shell
- **Style:** Franja superior en azul cobalto (`#0b5394`), texto y enlaces en blanco.
- **Nav Links:** Enlaces con altura mínima de `44px`, borde blanco de 1px, texto subrayado; en estado activo se invierten a fondo blanco con texto azul.
- **Session Bar:** Muestra usuario, taller y rol con botón de "Cerrar sesión" accesible en un toque en cualquier ancho de pantalla (desde 360 px).

## Do's and Don'ts

### Do:
- **Do** garantizar que todo elemento interactivo o clicable cumpla como mínimo `44 × 44 px` de área de toque.
- **Do** presentar siempre placas ecuatorianas en mayúsculas, negrita y con espacio tipográfico (`0.05em`).
- **Do** emplear números tabulares (`tabular-nums`) para kilometrajes, cotizaciones y códigos técnicos.
- **Do** utilizar el contorno ámbar `#f1c232` como indicador universal de foco visible.
- **Do** mantener el fondo blanco o tonal claro con bordes sólidos de alto contraste para visibilidad en bahía.

### Don't:
- **Don't** aplicar degradados decorativos de color ni efectos de sombras difusas o "glassmorphism".
- **Don't** utilizar textos en tonos de gris claro que violen el ratio de contraste mínimo 4.5:1 (WCAG AA).
- **Don't** crear botones compactos de escritorio (< 44px) en pantallas operativas de bahía.
- **Don't** alterar los códigos cromáticos semánticos establecidos para check-ins, presupuestos y órdenes de trabajo.
- **Don't** introducir animaciones lentas o transiciones cosméticas que retarden la captura de información en recepción.
