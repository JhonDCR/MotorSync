# Quickstart: validar 001-clientes-vehiculos de punta a punta

Guía para comprobar que la feature funciona. Los detalles están en [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml) y [research.md](./research.md). Los scripts `npm run db:*`, `token:dev` y `test:perf` los crean las tareas de esta feature.

## 0. Prerrequisitos

- Node 22, Docker y los scaffolds de `backend/` y `frontend/` con `npm ci` hecho.
- `.env` copiado de `.env.example`. Esta feature añade a `.env.example`:
  `DATABASE_ADMIN_URL`, `DATABASE_MIGRATOR_URL`, `DATABASE_URL` (rol `motorsync_app`), `DB_APP_PASSWORD`, `DB_MIGRATOR_PASSWORD` y `JWT_SECRET` (≥ 32 caracteres).

## 1. Base de datos

```bash
docker compose up -d                 # PostgreSQL 16
cd backend
npm run db:bootstrap                 # roles motorsync_migrator / motorsync_app y extensiones (idempotente)
npm run build && npm run db:migrate  # migraciones como motorsync_migrator
npm run db:seed:dev                  # 2 talleres de ejemplo (A y B) con algunos clientes y vehículos
```

**Comprobar**, conectado como `motorsync_app`:
- `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;` → `f`.
- `SELECT count(*) FROM vehicles;` sin `app.tenant_id` → `0` (RLS sin tenant no ve nada).
- `DELETE FROM vehicles;` → `permission denied`. `UPDATE audit_log SET reason = 'x';` → `permission denied`.

## 2. API

```bash
npm run start:dev
npm run token:dev -- --tenant <uuid-taller-A> --role asesor --name "Ana Asesora"   # imprime TOKEN_A
npm run token:dev -- --tenant <uuid-taller-B> --role admin  --name "Bruno Admin"   # imprime TOKEN_B
```

Los uuid de los talleres los imprime `db:seed:dev`.

| # | Petición (con `Authorization: Bearer ...`) | Resultado esperado | Criterio |
|---|---|---|---|
| 1 | `POST /api/v1/clients` (A) con cédula válida | 201 | US2-AC1 |
| 2 | Repetir 1 con el documento con guion | 409 `DOCUMENT_ALREADY_EXISTS` + `existingId` | US2-AC6 |
| 3 | `POST /api/v1/clients` (B) con el mismo documento | 201 | US2-AC9 |
| 4 | `POST /api/v1/clients` con `"tenantId": "<B>"` en el body | 400 `VALIDATION_ERROR` | US2-AC10 |
| 5 | `POST /api/v1/vehicles` (A) con `plate: "pba-1234"`, `bodyType: "sedan"` | 201, `plate: "PBA1234"` | US3-AC1, AC2 |
| 6 | `POST /api/v1/vehicles` con `plate: "AB123C"`, `bodyType: "sedan"` | 400 `VALIDATION_ERROR` con `errors[].code = INVALID_PLATE` | US3-AC12 |
| 7 | `POST /api/v1/vehicles` con `plate: "AB123C"`, `bodyType: "motorcycle"` | 201 | US3-AC13 |
| 8 | `GET /api/v1/vehicles/search?q=ba12` (A) | `PBA1234` en `items` | US1-AC3 |
| 9 | `GET /api/v1/vehicles/search?q=ba12` (B) | `items: []` | US1-AC8 |
| 10 | `GET /api/v1/vehicles/<id-de-A>` con TOKEN_B | 404 `NOT_FOUND` | US1-AC9 |
| 11 | `POST /api/v1/vehicles/<id>/ownership-transfers` (asesor A) sin `reason` | 400 `VALIDATION_ERROR` con `errors[].code = REASON_REQUIRED`, sin auditoría | US4-AC15 |
| 12 | Igual que 11 pero con `reason` válido y `version` vigente | 200 con el nuevo `owner` | US4-AC7 |
| 13 | `GET /api/v1/vehicles/<id>/ownership-history` | 1 elemento con motivo, actor y rol | US4-AC8, AC10 |
| 14 | `PATCH /api/v1/vehicles/<id>` con una `version` antigua | 409 `VERSION_CONFLICT` + `current` | US4-AC12 |
| 15 | `DELETE /api/v1/vehicles/<id>` | 404, el vehículo sigue existiendo | US4-AC17 |

## 3. Pruebas automáticas

```bash
cd backend
npm run lint && npm test          # unitarias: normalización, validadores, servicios
npm run test:e2e                  # e2e contra PostgreSQL real: contrato, RLS, auditoría y concurrencia
cd ../frontend
npm run lint && npm test -- --watch=false
```

Cada prueba cita en su nombre el ID del criterio que cubre (`US1-AC8 ...`), según el principio II.

## 4. Frontend

```bash
cd frontend
npm start -- --configuration mock   # sin backend: interceptor de mocks con datos en memoria
npm start                           # contra la API real (proxy /api -> http://localhost:3000)
```

- Abrir `/dev-token` (solo en desarrollo) y pegar TOKEN_A.
- En las DevTools, en modo dispositivo a 360 × 640 y a 768 × 1024, comprobar:
  - la búsqueda por placa es la pantalla inicial y muestra resultados mientras se escribe (FR-026);
  - no hay scroll horizontal y los botones y campos miden al menos 44 px de alto (FR-025);
  - una búsqueda sin resultados ofrece "Registrar vehículo" con la placa precargada (US1-AC6, US3-AC9);
  - un asesor que transfiere un vehículo ve el campo de motivo obligatorio; con un token `admin` es opcional.

## 5. Rendimiento

```bash
cd backend
npm run test:perf   # siembra 10 talleres × (30 000 clientes + 50 000 vehículos) y mide el p95
```

Esperado: el p95 de placa (exacta y parcial), documento y VIN es menor que 200 ms; el plan de consultas no contiene `Seq Scan` sobre `vehicles` ni `clients` (SC-001, US1-AC10).
