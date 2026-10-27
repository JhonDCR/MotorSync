# Quickstart: validar la 005

1. Arranque local según `CLAUDE.md` (build, `db:migrate`, `db:seed:dev`, `start:dev`).
2. `cd backend && npx vitest run --config vitest.e2e.config.ts test/budgets.e2e-spec.ts`: US1-AC1..AC4, US2-AC1..AC2, US3-AC1..AC2.
3. Manual: `admin@taller-a.test`, abre un check-in, "Nuevo presupuesto", agrega 2 líneas, verifica 62,00 / 9,30 / 71,30; enviar → aprobar; el botón de edición desaparece.
4. Con `admin@taller-b.test`, la URL del detalle anterior → "no encontrado".
