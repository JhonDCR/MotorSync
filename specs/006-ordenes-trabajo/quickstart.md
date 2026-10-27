# Quickstart: validar la 006

1. Arranque local según `CLAUDE.md` (build, `db:migrate`, `db:seed:dev`, `start:dev`).
2. `cd backend && npx vitest run --config vitest.e2e.config.ts test/work-orders.e2e-spec.ts`: US1-AC1..AC4, US2-AC1..AC4, US3-AC1..AC2.
3. Manual: `admin@taller-a.test`, aprueba un presupuesto, "Crear OT", avanza a entregada; el historial muestra 4 cambios.
4. Con `admin@taller-b.test`, la URL del detalle anterior → "no encontrado".
