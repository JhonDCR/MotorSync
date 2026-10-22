# MotorSync: guía para agentes

SaaS multi-tenant para talleres automotrices (check-in 360°, presupuestos, OT, inventario, historial por placa). Monorepo con Angular, NestJS y PostgreSQL, desarrollado con Spec-Driven Development.

**Lee primero la constitución:** [.specify/memory/constitution.md](.specify/memory/constitution.md). Si algo de este archivo la contradice, gana la constitución.

## Mapa del repo

| Ruta | Contenido |
|---|---|
| `specs/<NNN-feature>/` | `spec.md`, `plan.md`, `tasks.md`, `contracts/`, `data-model.md` de cada feature |
| `.specify/` | Spec Kit: constitución, plantillas y scripts (PowerShell) |
| `.claude/skills/speckit-*` | Skills de Spec Kit (`/speckit-specify`, `/speckit-plan`, …) |
| `.claude/agents/` | Subagentes del arnés (ver "Flujo de agentes") |
| `.claude/hooks/` | Controles deterministas (guardia de rutas y checks post-edición) |
| `backend/` | NestJS 12: `src/` (módulos), `test/` (e2e con `*.e2e-spec.ts`) |
| `frontend/` | Angular 22 standalone: `src/app/` (componentes, rutas, servicios) |
| `.github/workflows/ci.yml` | Pipeline: harness, backend y frontend |

## Comandos

```bash
docker compose up -d          # PostgreSQL local (requiere .env, copiar de .env.example)
node --test ".claude/hooks/*.test.mjs"   # pruebas del arnés
```

Backend (`cd backend`, NestJS 12 con Vitest y oxlint): `npm run lint`, `npm test`, `npm run test:e2e`, `npm run build`, `npm run start:dev`.
Una sola prueba: `npx vitest run src/ruta/archivo.spec.ts`. Pruebas relacionadas con un archivo: `npx vitest related src/ruta/archivo.ts --run`.

Arranque local del backend, en orden (los scripts de BD ejecutan `dist/`, por eso `build` va primero):

```bash
docker compose up -d                 # en la raíz; requiere .env copiado de .env.example
cd backend && npm run build
npm run db:bootstrap                 # roles motorsync_migrator y motorsync_app + extensiones (idempotente)
npm run db:migrate                   # como motorsync_migrator (idempotente)
npm run token:dev -- --tenant <uuid> --role asesor --name "Ana"   # JWT HS256 de desarrollo
npm run start:dev                    # API en http://localhost:3000/api/v1
```

Las e2e (`npm run test:e2e`) corren en serie contra PostgreSQL real y aplican las migraciones en su `globalSetup`. Si el puerto 5432 lo ocupa otro PostgreSQL, apunta las variables a otro contenedor: las variables exportadas en el proceso ganan sobre `.env`.

Frontend (`cd frontend`, Angular 22 con Vitest + jsdom y angular-eslint): `npm run lint`, `npm test -- --watch=false`, `npm run build`, `npm start`.
Una sola prueba: `npx ng test --include=src/app/ruta/archivo.spec.ts --watch=false`.
Sin backend: `npx ng serve --configuration mock` (API simulada en memoria con las mismas reglas del contrato). Con backend: `npm start` usa el proxy `/api` → `localhost:3000`; pega un token de `npm run token:dev` en `/dev-token`.

## Convenciones

- Ramas: `feat/`, `fix/`, `chore/`, `ci/`, `docs/`, más una descripción corta en kebab-case. Nunca se trabaja en `main`.
- Commits: Conventional Commits (`feat(vehiculos): buscar por placa`).
- PR: referencia la issue con `Closes #N` y resume qué criterios de aceptación cubre.
- Código en inglés (identificadores, nombres de archivos). Specs, commits, PRs y mensajes al usuario en español.
- Nunca leas ni escribas `.env`. No hagas `git push` sin que el humano lo pida.

## Flujo de agentes

La sesión principal es el **leader**: lee `specs/<feature>/tasks.md`, delega cada tarea al subagente que corresponde, integra los resultados y no escribe código de producción por su cuenta.

1. `spec-writer`: crea o actualiza la spec, el plan y las tareas con las skills `/speckit-*`. **✋ Para aquí hasta que el humano apruebe spec y plan.**
2. `tester`: escribe las pruebas en rojo de una tarea a partir de sus criterios de aceptación.
3. `implementer-backend` / `implementer-frontend`: escriben el código mínimo para poner esas pruebas en verde. No tocan pruebas.
4. `reviewer`: revisa el diff (solo lectura) contra la spec y la constitución. Si pide cambios, se vuelve al paso 3.
5. El leader propone el commit y el PR. **✋ El merge lo aprueba el compañero en GitHub.**

Los permisos de cada rol los impone `.claude/hooks/guard-paths.mjs`. Si un hook bloquea una acción, no lo rodees (con Bash, renombrando o de otra forma): reporta el bloqueo al leader.

## Lecciones

Cuando un agente cometa el mismo error dos veces, agrega aquí la regla que lo evita (una línea, en imperativo).

- (vacío)
