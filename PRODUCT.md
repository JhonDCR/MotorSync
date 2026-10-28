# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Asesor de servicio / Recepcionista** (usuario principal): atiende al cliente en la recepción y en la bahía de ingreso desde tablet o smartphone; busca vehículos por placa al instante, registra clientes, ejecuta la inspección física check-in 360° con captura fotográfica de daños y firma digital, y genera presupuestos de servicio.
- **Técnico / Mecánico**: opera en el taller desde tablets de bahía o puestos de trabajo; gestiona órdenes de trabajo (OT) asignadas en el tablero kanban, registra avances y reporta consumo de repuestos y tiempos.
- **Administrador del taller**: gestiona usuarios, supervisa métricas de facturación y tiempos, consulta la bitácora inmutable de auditoría y autoriza transferencias de vehículos o correcciones de datos maestros.
- **Operador de soporte de plataforma (Soporte MotorSync)**: superusuario técnico independiente de los talleres; gestiona tickets de asistencia y reseteos controlados de contraseñas bajo registro append-only estricto.
- **Cliente del taller (propietario del vehículo)**: actor externo sin cuenta fija; firma la recepción del vehículo en la tablet de bahía y revisa, aprueba o rechaza cotizaciones de reparación mediante enlace web público interactivo.

## Product Purpose

MotorSync es una plataforma SaaS multi-tenant orientada a la gestión operativa, técnica y presupuestaria de talleres mecánicos y de colisión automotriz en Ecuador. Resuelve la falta de transparencia, las disputas por daños preexistentes y la fricción en la aprobación de trabajos, proporcionando:
- Búsqueda inmediata del vehículo por placa como punto de partida de toda la operación.
- Registro visual y pericial inmutable del estado del vehículo al ingresar (check-in 360° con fotos y firma).
- Presupuestos interactivos aprobables en un toque por el cliente vía enlace.
- Control en tiempo real del flujo de trabajo en taller (OT) e historial clínico por placa.

## Positioning

A diferencia de los ERPs administrativos genéricos o los sistemas de escritorio tradicionales para concesionarios, MotorSync está diseñado para el ritmo dinámico de la bahía automotriz ecuatoriana:
- Mobile/Tablet-First nativo: flujos táctiles pensados para usar de pie en el vehículo con metas táctiles amplias (>= 44 px).
- Cumplimiento normativo de Ecuador: validación estricta de cédula, RUC (con algoritmo de dígito verificador) y placas oficiales de autos y motos según estándares ANT.
- Blindaje multi-tenant riguroso: aislamiento absoluto por Row-Level Security (RLS) en PostgreSQL 16 y auditoría append-only que protege al taller ante reclamos.

## Operating Context

- **Entorno físico**: bahía de servicio y recepción de talleres mecánicos; ambiente ruidoso, iluminación variable, manipulación en movimiento y uso con dedos o guantes.
- **Dispositivos**: tablets y teléfonos de gama media en bahía (PWA con compresión de fotos en el cliente), más pantallas de escritorio en oficinas y recepción.
- **Rituales operativos**:
  - Check-in 360° al recibir el vehículo: registro de kilometraje, nivel de combustible, inventario de pertenencias/herramientas, marcado de daños por vista (frontal, posterior, laterales, techo) con fotos y firma digital del cliente.
  - Envío y aprobación digital de cotizaciones (repuestos y mano de obra) antes de iniciar labores.
  - Tablero de seguimiento de órdenes de trabajo para técnicos en taller.
  - Consulta de la hoja de vida / historial clínico del vehículo por placa.

## Capabilities and Constraints

- **Capacidades funcionales**:
  - Búsqueda de vehículos por placa, VIN o documento con respuesta inferior a 200 ms (p95).
  - Normalización automática de placas vehiculares (mayúsculas, sin espacios ni guiones) validando formato ecuatoriano de autos (3 letras + 3 o 4 dígitos) y motos (2 letras + 3 dígitos + 1 letra).
  - Registro y gestión de clientes (personas naturales con cédula, empresas con RUC, extranjeros con pasaporte).
  - Check-in 360° inmutable con evidencia fotográfica (JPEG/PNG <= 1 MB) y firma en pantalla.
  - Presupuestos desglosados en mano de obra y repuestos con ciclo de vida (borrador, enviado, aprobado, rechazado).
  - Tablero kanban para órdenes de trabajo.
  - Historial clínico por placa con auditoría de cambios de propietario e intervenciones.
  - Módulo de soporte de plataforma desacoplado de los datos de negocio de los talleres.
- **Restricciones técnicas**:
  - Frontend: Angular 22 standalone (PWA, responsive con CSS/SCSS).
  - Backend: NestJS con TypeScript estricto (`strict: true`) y validación de DTOs en el borde.
  - Base de datos: PostgreSQL 16 con Row-Level Security activado por `tenant_id`.
  - Auditoría append-only (`audit_log`) en la misma transacción del evento auditado.
  - Metodología: Spec-Driven Development (SDD) y Test-First (TDD con Vitest).

## Brand Commitments

- **Nombre**: MotorSync.
- **Tono y voz**: Profesional, técnico, ágil, transparente y seguro. Vocabulario automotriz claro en español.
- **Identidad visual base**: Azul institucional (`#0b5394`), texto oscuro de alto contraste (`#1a1a1a`), foco accesible (`#f1c232`), cumpliendo contraste WCAG AA.

## Evidence on Hand

- Código fuente estructurado en monorepo (`frontend/`, `backend/`).
- Especificaciones funcionales y planes de arquitectura completos en `specs/001-clientes-vehiculos/` a `specs/007-historial-placa/`.
- Constitución técnica y principios no negociables en `.specify/memory/constitution.md`.
- No fabricar: testimonios inventados, métricas de mercado falsas o características fuera de las especificaciones aprobadas.

## Product Principles

- **Bahía primero (Field-First)**: La interfaz prioriza la ergonomía en tablet de bahía; rapidez en un toque, metas táctiles de al menos 44 px y cero pasos burocráticos innecesarios al recibir un auto.
- **Evidencia inalterable**: Toda inspección, firma, daño reportado o presupuesto aprobado genera un registro fidedigno e inmutable que protege tanto al taller como al cliente.
- **Velocidad sin fricción**: Búsqueda instantánea por placa en menos de 200 ms como eje de acceso inmediato a la información técnica y comercial.
- **Aislamiento estricto**: Cada taller es un silo de datos inviolable protegido por RLS a nivel de motor de base de datos; cero riesgo de filtración cruzada.

## Accessibility & Inclusion

- Cumplimiento de estándares WCAG 2.1 nivel AA (contraste mínimo de color para legibilidad en condiciones de luz de taller).
- Objetivos táctiles mínimos garantizados de 44 × 44 px en botones, enlaces y controles interactivos en bahía.
- Formularios con validación en tiempo real y mensajes de error contextuales claros en español.
