# Quickstart: validar la 004

1. Arranque local según `CLAUDE.md` (build, `db:migrate`, `db:seed:dev`, `start:dev`).
2. `cd backend && npx vitest run --config vitest.e2e.config.ts test/checkins.e2e-spec.ts` (o `npm run test:e2e`): cubre US1-AC1..AC5 y US2-AC1..AC3.
3. Manual: inicia sesión como `admin@taller-a.test`, busca un vehículo, "Nuevo check-in", marca un daño con foto, firma y guarda; el historial del vehículo muestra el check-in y el detalle muestra foto y firma.
4. Con `admin@taller-b.test`, abrir la URL del detalle anterior → "no encontrado".
