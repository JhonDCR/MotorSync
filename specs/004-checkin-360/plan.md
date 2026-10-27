# Implementation Plan: Check-in 360° de recepción del vehículo

**Branch**: `feat/004-checkin-360` | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)
**Aprobación**: pendiente del humano (spec y plan).
**Modo**: ligero (entrega 2026-10-30). Sin `research.md`: las decisiones van en "Decisiones" abajo.

## Summary

Módulo `checkins` (backend + frontend) que crea check-ins inmutables de un vehículo de la 001 con daños por vista, foto opcional por daño y firma del cliente, y los lista y muestra por vehículo. Reutiliza el contexto de tenant por transacción, RLS, guardias de sesión/rol y Problem Details de la 001/002.

## Technical Context

- **Stack**: NestJS 12 + TypeORM (`backend/src/checkins/`), Angular 22 standalone (`frontend/src/app/features/checkins/`), PostgreSQL 16 con RLS.
- **Pruebas**: Vitest; e2e contra PostgreSQL real (`backend/test/checkins.e2e-spec.ts`); frontend con jsdom.
- **Restricciones**: pantallas táctiles (44 px), imágenes comprimidas en el cliente, sin librerías nuevas.

## Decisiones

| # | Decisión | Por qué / alternativa descartada |
|---|---|---|
| D1 | **Fotos y firma como `bytea` en PostgreSQL** (tabla `checkin_images`), enviadas en el mismo JSON como base64, ≤ 1 MB cada foto tras comprimir en el cliente (canvas → JPEG 0.7, máx. 1280 px). | Lo más simple: una sola transacción (FR-006), RLS protege las imágenes igual que los datos y no hay servicio de almacenamiento nuevo. Descartado: S3/disco (otro servicio, secretos, borrado huérfano). |
| D2 | Un solo `POST /vehicles/{vehicleId}/checkins` con todo el check-in; límite de body 25 MB solo en esa ruta. | Atómico y sin estados "borrador". |
| D3 | Imágenes servidas por `GET /checkins/{id}/images/{imageId}` (binario), no embebidas en el detalle. | Detalle liviano; la foto se carga con `<img>` vía blob con el token. |
| D4 | Número correlativo con tabla `checkin_counters (tenant_id PK, last_number)` y `UPDATE … RETURNING` en la misma transacción. | Igual de simple que una secuencia, pero por taller y sin huecos entre talleres. |
| D5 | Kilometraje mínimo (FR-004) se valida en el servicio con `SELECT max(mileage)` del vehículo dentro de la transacción; sin bloqueo (concurrencia fuera de alcance). | Modo ligero. |
| D6 | Inmutabilidad (FR-007): sin rutas PUT/PATCH/DELETE; `motorsync_app` solo tiene `SELECT, INSERT` en las tablas de check-in. | Segunda barrera en BD, como `audit_log`. |
| D7 | Sin `audit_log`: crear check-in no es evento auditable (constitución IV); el registro es inmutable y guarda autor y fecha. | YAGNI. |
| D8 | Validación de imagen por magic bytes (JPEG `FFD8FF`, PNG `89504E47`) y tamaño decodificado. | No confiar en el `mime` enviado por el cliente. |

## Constitution Check

| Principio | Cómo se cumple | Estado |
|---|---|---|
| I. `tenant_id NOT NULL`, FK a `tenants`, índice | `checkins`, `checkin_damages`, `checkin_images`, `checkin_counters` ([data-model](./data-model.md)). FK compuesta `(tenant_id, vehicle_id)` → `vehicles` impide mezclar talleres. | Cumple |
| I. RLS `ENABLE` + `FORCE` con `app.tenant_id` | Política `tenant_isolation` en las 4 tablas, igual que la 001. | Cumple |
| I. Tenant desde la sesión | Se reutiliza el contexto de tenant de `database/tenant-context` y las guardias de la 002; nada del body/query. | Cumple |
| I. Prueba A no lee/modifica B | US1-AC5, US2-AC2 en e2e + prueba de BD sin tenant → 0 filas. | Cumple |
| I. Sin lecturas entre talleres | No hay funciones nuevas cruzadas. | Cumple |
| II. Test-first, IDs de AC | Cada tarea de implementación va precedida de su prueba en rojo con IDs `US*-AC*`. | Cumple |
| III. Spec, plan, tasks y contrato antes | [contracts/openapi.yaml](./contracts/openapi.yaml). | Cumple |
| IV. Auditoría | No aplica (D7); el check-in es inmutable (D6). | Cumple |
| V. Strict, DTOs validados, YAGNI | DTOs con class-validator; sin librerías ni servicios nuevos (D1). | Cumple |
| Móvil en bahía / compresión en cliente | Formulario táctil, compresión antes de subir (D1). | Cumple |

## Project Structure

```text
backend/src/checkins/            checkins.module.ts, checkins.controller.ts, checkins.service.ts, dto/, image.util.ts
backend/src/database/migrations/ 1761000001600-CreateCheckins.ts
backend/test/checkins.e2e-spec.ts
frontend/src/app/features/checkins/  checkin.service.ts, checkin-form/, damage-map/, signature-pad/, checkin-list/, checkin-detail/
```

## Complexity Tracking

Ninguna.

## Riesgos

- Tamaño de BD por imágenes en `bytea`: aceptable para la entrega; migrar a almacenamiento de objetos es un cambio interno sin tocar el contrato.
- Body grande (hasta ~22 MB con 20 fotos): límite explícito solo en la ruta de creación.
